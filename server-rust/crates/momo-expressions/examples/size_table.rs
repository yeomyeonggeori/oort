//! #5455 실측표: 서버 재인코딩(`media::decode`)이 실제 그림 묶음에 만드는 바이트·치수·프레임·시간.
//! **시험이 아니라 예제(`examples/`)다** — 사람이 손으로 돌린다. 앞 판은 `tests/size_table.rs` 의 `#[ignore]` 시험이었는데, 표본 그림이
//! 공개 저장소에 없어서 `MOMO_EXPRESSION_SAMPLES` 가 없는 야간 러너(`--ignored` 전량 실행)에서는 늘 빨강이었다(#5455 B-1, 야간 격리 줄을 없앴다).
//! 예제는 `cargo test` 에 들어가지 않으므로 CI·야간이 돌리지 않는다. 그림은 저장소에 없다(공개 저장소).
//!
//! ```text
//! MOMO_EXPRESSION_SAMPLES=<폴더: stills/*.png, gifs/*.gif> \
//! MOMO_EXPRESSION_TABLE_OUT=<결과를 쓸 .json 경로> \
//! cargo run -p momo-expressions --example size_table
//! ```
//!
//! `MOMO_EXPRESSION_DUMP=<폴더>` 를 주면 만들어진 small/large/thumb 파일도 거기에 쓴다(눈으로·다른 디코더로 대조용).
//! 수리 전·후는 같은 명령을 두 트리에서 돌려 JSON 둘을 비교한다. 색 수·투명 밑 색 잡음은
//! 「무손실로 어디까지 가나」를 정하는 입력이다(정확한 팔레트가 가능한가, 투명 밑 색을 비워도 되나).
use image::{AnimationDecoder, ImageDecoder, ImageFormat};
use momo_expressions::media::{decode, Rendition};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn files(dir: &Path, extension: &str) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == extension))
        .collect();
    found.sort();
    found
}

fn row(r: &Rendition, took: Duration) -> Value {
    json!({
        "bytes": r.data.len(),
        "w": r.info.width,
        "h": r.info.height,
        "frames": r.info.frame_count,
        "durationMs": r.info.duration_ms,
        "mime": r.info.mime,
        "sha256": r.info.sha256,
        "decodeMs": took.as_secs_f64() * 1000.0,
    })
}

/// 색 수: 불투명 픽셀의 서로 다른 RGB(알파 0은 보이지 않으므로 세지 않는다).
fn opaque_colors(images: &[image::RgbaImage]) -> usize {
    let mut seen = HashSet::new();
    for image in images {
        for p in image.pixels() {
            if p.0[3] != 0 {
                seen.insert([p.0[0], p.0[1], p.0[2]]);
            }
        }
    }
    seen.len()
}

/// 알파 0인 픽셀 밑에 깔린 서로 다른 RGB 수(1이면 이미 한 색으로 비어 있다).
fn under_transparent(images: &[image::RgbaImage]) -> usize {
    let mut seen = HashSet::new();
    for image in images {
        for p in image.pixels() {
            if p.0[3] == 0 {
                seen.insert([p.0[0], p.0[1], p.0[2]]);
            }
        }
    }
    seen.len()
}

fn alpha_census(image: &image::RgbaImage) -> (usize, usize, usize) {
    let (mut zero, mut full, mut part) = (0, 0, 0);
    for p in image.pixels() {
        match p.0[3] {
            0 => zero += 1,
            255 => full += 1,
            _ => part += 1,
        }
    }
    (zero, full, part)
}

/// 눈에 보이는 차이: 그려진 픽셀(알파 != 0)의 최대 채널 오차의 평균·최악, 그려짐/안 그려짐이 다른 픽셀 수.
fn gif_error(output: &[u8], ideal: &[image::RgbaImage]) -> Value {
    let frames: Vec<image::RgbaImage> = image::codecs::gif::GifDecoder::new(Cursor::new(output))
        .unwrap()
        .into_frames()
        .map(|f| f.unwrap().into_buffer())
        .collect();
    assert_eq!(frames.len(), ideal.len());
    let (mut total, mut worst, mut count, mut visibility) = (0u64, 0u32, 0u64, 0u64);
    for (got, want) in frames.iter().zip(ideal) {
        assert_eq!(got.dimensions(), want.dimensions());
        for (a, b) in got.pixels().zip(want.pixels()) {
            match (a.0[3] != 0, b.0[3] != 0) {
                (false, false) => {}
                (true, true) => {
                    let e = (0..3)
                        .map(|c| u32::from(a.0[c].abs_diff(b.0[c])))
                        .max()
                        .unwrap();
                    worst = worst.max(e);
                    total += u64::from(e);
                    count += 1;
                }
                _ => visibility += 1,
            }
        }
    }
    json!({ "mean": total as f64 / count.max(1) as f64, "worst": worst, "visibilityMismatch": visibility })
}

fn still_stats(
    source: &[u8],
    processed: Option<&momo_expressions::media::Processed>,
    out: &Value,
) -> Value {
    let image = image::load_from_memory(source).unwrap().to_rgba8();
    let max = |edge: u32| -> image::RgbaImage {
        let e = edge.min(image.width().max(image.height()));
        image::DynamicImage::ImageRgba8(image.clone())
            .thumbnail(e, e)
            .to_rgba8()
    };
    let (small, large) = (max(128), max(512));
    let (zero, full, part) = alpha_census(&large);
    // 무손실이라는 주장의 증거: 만들어진 그림을 다시 읽으면 줄인 원본과 모든 채널이 같다.
    let changed = processed.map(|p| {
        let differs = |data: &[u8], want: &image::RgbaImage| {
            image::load_from_memory(data)
                .unwrap()
                .to_rgba8()
                .pixels()
                .zip(want.pixels())
                .filter(|(a, b)| a != b)
                .count()
        };
        json!({
            "small": differs(&p.small.data, &small),
            "large": differs(&p.large.data, &large),
            "thumb": differs(&p.thumb.data, &small),
        })
    });
    json!({
        "pixelsChanged": changed,
        "srcColorsOpaque": opaque_colors(std::slice::from_ref(&image)),
        "largeColorsOpaque": opaque_colors(std::slice::from_ref(&large)),
        "smallColorsOpaque": opaque_colors(std::slice::from_ref(&small)),
        "largeUnderTransparentRgb": under_transparent(std::slice::from_ref(&large)),
        "largeAlpha": { "zero": zero, "full": full, "partial": part },
        "out": out,
    })
}

fn gif_stats(
    source: &[u8],
    processed: Option<&momo_expressions::media::Processed>,
    out: &Value,
) -> Value {
    let decoder = image::codecs::gif::GifDecoder::new(Cursor::new(source)).unwrap();
    let frames: Vec<image::RgbaImage> = decoder
        .into_frames()
        .map(|f| f.unwrap().into_buffer())
        .collect();
    let shrunk = |edge: u32| -> Vec<image::RgbaImage> {
        frames
            .iter()
            .map(|f| {
                let e = edge.min(f.width().max(f.height()));
                image::DynamicImage::ImageRgba8(f.clone())
                    .thumbnail(e, e)
                    .to_rgba8()
            })
            .collect()
    };
    let (large, small) = (shrunk(512), shrunk(128));
    let error = processed.map(|p| {
        json!({
            "small": gif_error(&p.small.data, &small),
            "large": gif_error(&p.large.data, &large),
        })
    });
    json!({
        "error": error,
        "srcColorsOpaque": opaque_colors(&frames),
        "largeColorsOpaque": opaque_colors(&large),
        "smallColorsOpaque": opaque_colors(&small),
        "largeUnderTransparentRgb": under_transparent(&large),
        "out": out,
    })
}

fn main() {
    let dir = PathBuf::from(
        std::env::var("MOMO_EXPRESSION_SAMPLES").expect("MOMO_EXPRESSION_SAMPLES=<폴더>"),
    );
    let mut rows = Vec::new();
    for (sub, extension) in [("stills", "png"), ("gifs", "gif")] {
        for path in files(&dir.join(sub), extension) {
            let source = std::fs::read(&path).unwrap();
            let (width, height) = image::ImageReader::with_format(
                Cursor::new(&source),
                if extension == "png" {
                    ImageFormat::Png
                } else {
                    ImageFormat::Gif
                },
            )
            .into_decoder()
            .unwrap()
            .dimensions();
            let frames = if extension == "gif" {
                image::codecs::gif::GifDecoder::new(Cursor::new(&source))
                    .unwrap()
                    .into_frames()
                    .count()
            } else {
                1
            };
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            // 시간은 세 번 재서 가운데 값(부하 잡음 줄이기). 결과는 같은 입력이면 같다.
            let mut times = Vec::new();
            let mut last = None;
            for _ in 0..3 {
                let t = Instant::now();
                let r = decode(&source, Instant::now() + Duration::from_secs(60));
                times.push(t.elapsed());
                last = Some(r);
            }
            times.sort();
            let took = times[1];
            let last = last.unwrap();
            let processed = last.as_ref().ok();
            let out = match &last {
                Ok(p) => {
                    if let Ok(dump) = std::env::var("MOMO_EXPRESSION_DUMP") {
                        std::fs::create_dir_all(&dump).unwrap();
                        for (variant, r) in p.variants() {
                            let extension = if r.info.mime == "image/gif" {
                                "gif"
                            } else {
                                "png"
                            };
                            std::fs::write(
                                Path::new(&dump).join(format!("{name}.{variant}.{extension}")),
                                &r.data,
                            )
                            .unwrap();
                        }
                    }
                    json!({
                    "ok": true,
                    "small": row(&p.small, took),
                    "large": row(&p.large, took),
                    "thumb": row(&p.thumb, took),
                    "decodeMs": took.as_secs_f64() * 1000.0,
                    })
                }
                Err(e) => {
                    json!({ "ok": false, "error": format!("{e:?}"), "decodeMs": took.as_secs_f64() * 1000.0 })
                }
            };
            let stats = if extension == "png" {
                still_stats(&source, processed, &out)
            } else {
                gif_stats(&source, processed, &out)
            };
            rows.push(json!({
                "name": name,
                "kind": if extension == "png" { "still" } else { "gif" },
                "orig": { "bytes": source.len(), "w": width, "h": height, "frames": frames },
                "stats": stats,
            }));
            let o = &rows.last().unwrap()["stats"]["out"];
            println!(
                "{name}\torig={}\tsmall={}\tlarge={}\tthumb={}\tms={:.0}",
                source.len(),
                o["small"]["bytes"],
                o["large"]["bytes"],
                o["thumb"]["bytes"],
                o["decodeMs"].as_f64().unwrap_or(0.0),
            );
        }
    }
    assert!(
        !rows.is_empty(),
        "no pictures found under {}",
        dir.display()
    );
    if let Ok(out) = std::env::var("MOMO_EXPRESSION_TABLE_OUT") {
        std::fs::write(&out, serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
    }
}

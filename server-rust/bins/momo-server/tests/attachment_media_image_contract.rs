//! Contract test for #5469 / ADR-0151 증보 9 (no database): `docs/api/openapi.yaml` and the wire a
//! photo's or GIF's size travels on — the request `PUT …/media` reads and the `media` summary every
//! projection carries — name the same keys, the same kind words and the same bounds.
//!
//! The precedent is `app_catalog_contract.rs`: the spec is read as text, so a drift between the
//! document and the code is a red test, not a surprise in a client. Every assertion compares the
//! spec to **a value the server computes** (a serialized summary, the closed list of picture types,
//! the bound a validator enforces, a request the route's own reader accepts or refuses), never to a
//! literal restated here.
//!
//! | test | what turns it red |
//! |---|---|
//! | `the_summary_is_a_one_of_whose_branches_are_the_two_serialized_shapes` | add a key to the picture's summary on one side and not the other; give the picture a `hasPoster` or `durationMs`; drop a branch of the `oneOf` |
//! | `the_bounds_are_the_ones_the_server_enforces` | change `MEDIA_MAX_DIMENSION` or the spec's `maximum` on either side |
//! | `the_request_is_a_one_of_and_the_route_reads_exactly_the_bodies_the_spec_describes` | a key the spec lists that the route refuses, or one the route reads that the spec does not list (the picture with a length or a poster) |
//! | `the_description_names_the_picture_types_the_server_accepts` | change `IMAGE_MIMES` without the spec's sentence |

use std::collections::BTreeSet;

use momo_messaging::attachment_media::MEDIA_MAX_DIMENSION;
use momo_messaging::{AttachmentMedia, IMAGE_MIMES};
use momo_server::routes::attachment_media::SetAttachmentMediaRequest;
use serde_json::{json, Value};

fn spec() -> String {
    std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../docs/api/openapi.yaml"
    ))
    .expect("read openapi.yaml")
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// The lines of `components.schemas.<schema>` (everything indented deeper than the schema's own key).
fn schema_lines(spec: &str, schema: &str) -> Vec<String> {
    let header = format!("\n    {schema}:\n");
    let start = spec
        .find(&header)
        .unwrap_or_else(|| panic!("schema {schema} is in the spec"))
        + header.len();
    spec[start..]
        .lines()
        .take_while(|line| line.is_empty() || indent_of(line) > 4)
        .map(str::to_string)
        .collect()
}

/// The direct property names of a components schema (properties sit at indent 8).
fn property_names(spec: &str, schema: &str) -> BTreeSet<String> {
    let mut in_properties = false;
    let mut names = BTreeSet::new();
    for line in schema_lines(spec, schema) {
        let text = line.trim();
        if indent_of(&line) == 6 && text == "properties:" {
            in_properties = true;
            continue;
        }
        if in_properties && indent_of(&line) == 6 {
            in_properties = false;
        }
        if in_properties && indent_of(&line) == 8 {
            if let Some((name, _)) = text.split_once(':') {
                names.insert(name.to_string());
            }
        }
    }
    names
}

/// `required: [a, b]` of a components schema.
fn required_names(spec: &str, schema: &str) -> BTreeSet<String> {
    let line = schema_lines(spec, schema)
        .into_iter()
        .find(|line| indent_of(line) == 6 && line.trim().starts_with("required:"))
        .unwrap_or_else(|| panic!("{schema} declares required"));
    line.trim()
        .trim_start_matches("required:")
        .trim()
        .trim_matches(|c| c == '[' || c == ']')
        .split(',')
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect()
}

/// The lines of one property of a schema (everything deeper than the property's own key).
fn property_lines(spec: &str, schema: &str, property: &str) -> Vec<String> {
    let lines = schema_lines(spec, schema);
    let key = format!("{property}:");
    let start = lines
        .iter()
        .position(|line| indent_of(line) == 8 && line.trim().starts_with(&key))
        .unwrap_or_else(|| panic!("{schema}.{property} is in the spec"));
    let mut block = vec![lines[start].clone()];
    for line in &lines[start + 1..] {
        if !line.is_empty() && indent_of(line) <= 8 {
            break;
        }
        block.push(line.clone());
    }
    block
}

/// The value after `key:` in one property's lines, e.g. `maximum: 16384` → `16384`.
fn scalar_of(spec: &str, schema: &str, property: &str, key: &str) -> String {
    let wanted = format!("{key}:");
    property_lines(spec, schema, property)
        .iter()
        .find(|line| line.trim().starts_with(&wanted))
        .unwrap_or_else(|| panic!("{schema}.{property} has {key}"))
        .trim()
        .trim_start_matches(&wanted)
        .trim()
        .to_string()
}

/// The `$ref` targets under a schema's `oneOf` (items sit at indent 8).
fn one_of_refs(spec: &str, schema: &str) -> Vec<String> {
    let lines = schema_lines(spec, schema);
    assert!(
        lines
            .iter()
            .any(|line| indent_of(line) == 6 && line.trim() == "oneOf:"),
        "{schema} is a oneOf"
    );
    lines
        .iter()
        .filter(|line| indent_of(line) == 8 && line.trim().starts_with("- $ref:"))
        .map(|line| {
            line.trim()
                .trim_start_matches("- $ref:")
                .trim()
                .trim_matches('"')
                .trim_start_matches("#/components/schemas/")
                .to_string()
        })
        .collect()
}

fn keys_of(value: &Value) -> BTreeSet<String> {
    value
        .as_object()
        .expect("an object")
        .keys()
        .cloned()
        .collect()
}

fn video() -> AttachmentMedia {
    AttachmentMedia::Video {
        duration_ms: 4200,
        width: 1280,
        height: 720,
        has_poster: true,
    }
}

fn picture() -> AttachmentMedia {
    AttachmentMedia::Image {
        width: 4032,
        height: 3024,
    }
}

#[test]
fn the_summary_is_a_one_of_whose_branches_are_the_two_serialized_shapes() {
    let spec = spec();
    assert_eq!(
        one_of_refs(&spec, "AttachmentMedia"),
        ["VideoAttachmentMedia", "ImageAttachmentMedia"],
        "the summary is exactly a video's or a picture's"
    );
    for (schema, media) in [
        ("VideoAttachmentMedia", video()),
        ("ImageAttachmentMedia", picture()),
    ] {
        let wire = serde_json::to_value(&media).expect("serialize");
        let sent = keys_of(&wire);
        assert_eq!(
            property_names(&spec, schema),
            sent,
            "{schema}: the spec's properties are the keys the server sends"
        );
        assert_eq!(
            required_names(&spec, schema),
            sent,
            "{schema}: every key the server sends is required (a summary is never half of one)"
        );
        assert_eq!(
            scalar_of(&spec, schema, "kind", "enum"),
            format!("[{}]", media.kind()),
            "{schema}: the branch is told apart by its kind word"
        );
        assert!(
            !schema_lines(&spec, schema)
                .iter()
                .any(|line| indent_of(line) == 6 && line.trim().starts_with("additionalProperties")),
            "{schema}: the drift gate reads an object with `properties` and no `additionalProperties` as closed"
        );
    }
    // the picture says nothing about a length or a poster, on the wire and in the spec
    let picture_keys = keys_of(&serde_json::to_value(picture()).expect("serialize"));
    assert_eq!(
        picture_keys,
        BTreeSet::from(["kind".into(), "width".into(), "height".into()])
    );
    for video_only in ["durationMs", "hasPoster"] {
        assert!(!picture_keys.contains(video_only));
        assert!(!property_names(&spec, "ImageAttachmentMedia").contains(video_only));
    }
    // the attachment carries it under `media`, by reference to the one-of
    assert!(property_names(&spec, "MessageAttachment").contains("media"));
    assert!(
        property_lines(&spec, "MessageAttachment", "media")
            .iter()
            .any(|line| line.contains("#/components/schemas/AttachmentMedia")),
        "MessageAttachment.media is the one-of"
    );
}

#[test]
fn the_bounds_are_the_ones_the_server_enforces() {
    let spec = spec();
    for schema in ["ImageAttachmentMedia", "SetImageAttachmentMediaRequest"] {
        for side in ["width", "height"] {
            assert_eq!(
                scalar_of(&spec, schema, side, "minimum"),
                "1",
                "{schema}.{side}"
            );
            assert_eq!(
                scalar_of(&spec, schema, side, "maximum"),
                MEDIA_MAX_DIMENSION.to_string(),
                "{schema}.{side}: the DB CHECK, the validator and the spec are one number"
            );
            assert_eq!(scalar_of(&spec, schema, side, "type"), "integer");
        }
    }
    // the video's side is held to the same number (one constant, one CHECK)
    assert_eq!(
        scalar_of(&spec, "VideoAttachmentMedia", "width", "maximum"),
        MEDIA_MAX_DIMENSION.to_string()
    );
}

#[test]
fn the_request_is_a_one_of_and_the_route_reads_exactly_the_bodies_the_spec_describes() {
    let spec = spec();
    assert_eq!(
        one_of_refs(&spec, "SetAttachmentMediaRequest"),
        [
            "SetVideoAttachmentMediaRequest",
            "SetImageAttachmentMediaRequest"
        ]
    );
    // both are closed objects
    for schema in [
        "SetVideoAttachmentMediaRequest",
        "SetImageAttachmentMediaRequest",
    ] {
        assert!(
            schema_lines(&spec, schema)
                .iter()
                .any(|line| indent_of(line) == 6 && line.trim() == "additionalProperties: false"),
            "{schema} is closed"
        );
    }
    let image_properties = property_names(&spec, "SetImageAttachmentMediaRequest");
    let video_properties = property_names(&spec, "SetVideoAttachmentMediaRequest");
    assert_eq!(
        image_properties,
        BTreeSet::from(["kind".into(), "width".into(), "height".into()])
    );
    assert_eq!(
        required_names(&spec, "SetImageAttachmentMediaRequest"),
        image_properties,
        "a picture names its kind and both numbers"
    );
    assert_eq!(
        video_properties,
        BTreeSet::from([
            "kind".into(),
            "durationMs".into(),
            "width".into(),
            "height".into(),
            "poster".into()
        ])
    );
    assert_eq!(
        required_names(&spec, "SetVideoAttachmentMediaRequest"),
        BTreeSet::from(["durationMs".into(), "width".into(), "height".into()]),
        "a video's `kind` is optional: a client older than the amendment sends none"
    );
    assert_eq!(
        scalar_of(&spec, "SetImageAttachmentMediaRequest", "kind", "enum"),
        "[image]"
    );
    assert_eq!(
        scalar_of(&spec, "SetVideoAttachmentMediaRequest", "kind", "enum"),
        "[video]"
    );

    // the route's own reader agrees with each branch ------------------------------------------------
    let read = |body: Value| serde_json::from_value::<SetAttachmentMediaRequest>(body);
    assert!(matches!(
        read(json!({"kind": "image", "width": 1, "height": 1})),
        Ok(SetAttachmentMediaRequest::Image(_))
    ));
    assert!(matches!(
        read(json!({"durationMs": 1, "width": 1, "height": 1})),
        Ok(SetAttachmentMediaRequest::Video(_))
    ));
    assert!(matches!(
        read(json!({"kind": "video", "durationMs": 1, "width": 1, "height": 1})),
        Ok(SetAttachmentMediaRequest::Video(_))
    ));
    // every key the spec gives a video and not a picture is a key the route refuses on a picture
    for only_a_videos in video_properties.difference(&image_properties) {
        let value = if only_a_videos == "poster" {
            json!({"mime": "image/jpeg", "dataBase64": "AAAA"})
        } else {
            json!(1)
        };
        let mut body = json!({"kind": "image", "width": 1, "height": 1});
        body[only_a_videos.as_str()] = value;
        assert!(
            read(body.clone()).is_err(),
            "the spec does not list `{only_a_videos}` for a picture, so the route must refuse {body}"
        );
    }
    // and no `kind` the spec does not list is read
    assert!(read(json!({"kind": "audio", "width": 1, "height": 1})).is_err());
}

#[test]
fn the_description_names_the_picture_types_the_server_accepts() {
    let spec = spec();
    let from = spec
        .find("operationId: setAttachmentMedia")
        .expect("the operation");
    let description =
        &spec[from..from + spec[from..].find("security:").expect("end of description")];
    for mime in IMAGE_MIMES {
        assert!(
            description.contains(mime),
            "the operation's description does not name {mime}"
        );
    }
    assert_eq!(IMAGE_MIMES.len(), 4, "the spec says four types");
}

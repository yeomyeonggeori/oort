import {
  composerInputLayout,
  type ComposerTextGeometry,
  type ComposerTextMeasurement,
} from '../src/features/conversation/composerInputLayout';
import {font, line} from '../src/design/tokens';

const geometry = (text: string, width = 250, fontScale = 1): ComposerTextGeometry => ({
  text, width, fontScale, fontSize: font.body, lineHeight: line.body,
});
const limits = (fontScale = 1) => ({
  minHeight: Math.max(44, Math.ceil(line.body * fontScale) + 18),
  maxHeight: 4 * line.body * fontScale + 18,
  chrome: 18,
});
const measured = (g: ComposerTextGeometry, rows: number): ComposerTextMeasurement => ({
  geometry: g, lineHeights: Array.from({length: rows}, () => g.lineHeight * g.fontScale),
});

describe('#4790 Fabric 고정 입력창과 독립적인 높이 결정', () => {
  it('명시 개행 없는 문단도 거울의 1→4→5줄에 따라 성장·상한·스크롤을 결정한다', () => {
    for (const fontScale of [1, 1.786, 2.143, 2.643, 3.143, 3.571]) {
      const g = geometry('개행 없이 계속 입력하는 긴 문단', 250, fontScale);
      for (const rows of [1, 2, 3, 4, 5, 10]) {
        const result = composerInputLayout(g, limits(fontScale), measured(g, rows));
        expect(result.rows).toBe(rows);
        expect(result.height).toBeCloseTo(Math.max(limits(fontScale).minHeight,
          Math.min(rows, 4) * line.body * fontScale + 18), 5);
        expect(result.scrollEnabled).toBe(rows > 4);
      }
    }
  });

  it('네 줄 뒤 다섯째 명시 줄은 측정 이벤트가 하나도 없어도 스크롤한다', () => {
    const four = geometry('하나\n둘\n셋\n넷');
    expect(composerInputLayout(four, limits(), null)).toEqual({rows: 4, height: 110, scrollEnabled: false});
    expect(composerInputLayout({...four, text: four.text + '\n'}, limits(), null))
      .toEqual({rows: 5, height: 110, scrollEnabled: true});
  });

  it('폭·글꼴 배수가 바뀌면 새 측정으로 다시 결정하고 빈 글은 즉시 줄인다', () => {
    const g = geometry('자동 줄바꿈 문단');
    const old = measured(g, 5);
    for (const next of [
      {...g, width: 500}, {...g, fontScale: 2}, {...g, fontSize: 20},
      {...g, lineHeight: 30},
    ]) {
      expect(composerInputLayout(next, limits(next.fontScale), old).scrollEnabled).toBe(false);
      expect(composerInputLayout(next, limits(next.fontScale), measured(next, 5)).scrollEnabled).toBe(true);
    }
    expect(composerInputLayout({...g, text: ''}, limits(), old))
      .toEqual({rows: 1, height: 44, scrollEnabled: false});
  });

  it('타이핑마다 거울의 다음 측정을 기다리는 동안 한 줄로 깜박이지 않는다', () => {
    const g = geometry('자동 줄바꿈 문단');
    const next = {...g, text: g.text + ' 계속'};
    expect(composerInputLayout(next, limits(), measured(g, 4)))
      .toEqual({rows: 4, height: 110, scrollEnabled: false});
    expect(composerInputLayout(next, limits(), measured(next, 5)))
      .toEqual({rows: 5, height: 110, scrollEnabled: true});
    const short = {...g, text: '짧은 글'};
    expect(composerInputLayout(short, limits(), measured(short, 1)))
      .toEqual({rows: 1, height: 44, scrollEnabled: false});
  });

  it('작은 창 예산으로 네 줄보다 낮아진 상한에서도 그 높이부터 스크롤한다', () => {
    const g = geometry('긴 문단', 200, 3);
    const twoRows = 2 * g.lineHeight * g.fontScale + 18;
    expect(composerInputLayout(g, {...limits(3), maxHeight: twoRows}, measured(g, 3)))
      .toEqual({rows: 3, height: twoRows, scrollEnabled: true});
  });
});

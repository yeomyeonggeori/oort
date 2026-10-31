import { listReleaseNotes, type ReleaseNote } from "../model";
import { RELEASE_NOTE_0_1_41 } from "./v0_1_41";

// =============================================================================
// 앱에 묶어 넣는 업데이트 소식의 등록부 (#4937).
//
// 릴리스마다 `notes/v<버전>.ts` 하나를 쓰고 여기에 더한다. 승격 때 통합자가 한다(`docs/RELEASING.md` §1).
// 순서는 어떻게 적어도 맞다: 화면과 규칙은 새 소식이 맨 위가 되도록 스스로 줄 세운다(`listReleaseNotes`).
// 더한 소식이 모양 규칙을 지키는지는 `model.test.ts`의 등록부 시험이 잰다(버전·번호 순서, 항목 수, ko·en 빈칸).
// =============================================================================

export const RELEASE_NOTES: readonly ReleaseNote[] = listReleaseNotes([RELEASE_NOTE_0_1_41]);

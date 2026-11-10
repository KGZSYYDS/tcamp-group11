export interface BoardGroup {
  id: string;
  route: string;
  label: string;
  subtypes: Readonly<Record<string, string>>;
}
export const BOARD_GROUPS: readonly BoardGroup[];
export function boardGroup(value?: string): BoardGroup | undefined;
export function boardNoticeId(value?: string): string | undefined;
export function inferBoardSubtype(group: BoardGroup, title: string): string | undefined;
export function readBoardMetadata(note?: string): {
  group?: BoardGroup;
  subtype?: string;
  classified: boolean;
  note?: string;
};
export function writeBoardMetadata(note: string | null | undefined, groupId: string, subtype?: string | null): string;

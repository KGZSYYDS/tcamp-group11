export const BOARD_TOPICS: Readonly<Record<"ENUM1" | "ENUM2" | "ENUM3" | "ENUM4" | "ENUM5" | "ENUM6", string>>;
export function readBoardNote(note?: string): { topic?: string; note?: string };
export function tagBoardNote(note: string | null | undefined, type: keyof typeof BOARD_TOPICS): string;

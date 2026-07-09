/** ANSI escape-code helpers shared by the encoder and the players. */

export const ESC = '\x1b';
export const RESET = `${ESC}[0m`;
export const HIDE_CURSOR = `${ESC}[?25l`;
export const SHOW_CURSOR = `${ESC}[?25h`;

/** Upper half block — top pixel = foreground, bottom pixel = background. */
export const HALF_BLOCK = '▀';

/** 24-bit foreground color. */
export function fg(r: number, g: number, b: number): string {
  return `${ESC}[38;2;${r};${g};${b}m`;
}

/** 24-bit background color. */
export function bg(r: number, g: number, b: number): string {
  return `${ESC}[48;2;${r};${g};${b}m`;
}

/** Move the cursor to the start of the line `n` lines up. */
export function cursorUpLines(n: number): string {
  return `${ESC}[${n}F`;
}

/** Erase from the cursor to the end of the screen. */
export const ERASE_DOWN = `${ESC}[0J`;

/**
 * Wrap text in an OSC 8 hyperlink. Terminals without OSC 8 support show the
 * plain text (the sequences themselves produce no visible output).
 */
export function osc8(url: string, text: string): string {
  return `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}

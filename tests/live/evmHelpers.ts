// Large Robinhood Chain EOAs (no code) found by scanning recent blocks on 2026-10-18. Used only as
// the `from` of eth_call simulations; balances move, so tests prefer state overrides when they can.
export const RICH_EOAS = ['0x53091256ebd2d8aa37b45536a5fd864ca764f32f', '0x1887fa9edadeab7562b01cc3f4fa246ace2c3cdd', '0x40795f87e87ee3786fbb3695d27b68eb460dfb0b'];

export function makeQuoteFixture() {
  return { richEoa: RICH_EOAS[0] };
}

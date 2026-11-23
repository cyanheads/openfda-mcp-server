/**
 * @fileoverview Setters for tests whose `vi.mock` factories expose a `__setMock`
 * hook on the canvas accessor and the openFDA service modules.
 * @module tests/helpers/mock-setters
 */

/** Points the mocked canvas accessor at `c`. */
export async function setCanvasMock(c: unknown) {
  const mod = await import('@/services/canvas/canvas-accessor.js');
  (mod as unknown as { __setMock: (c: unknown) => void }).__setMock(c);
}

/** Points the mocked openFDA service accessor at `s`. */
export async function setSvcMock(s: unknown) {
  const mod = await import('@/services/openfda/openfda-service.js');
  (mod as unknown as { __setMock: (s: unknown) => void }).__setMock(s);
}

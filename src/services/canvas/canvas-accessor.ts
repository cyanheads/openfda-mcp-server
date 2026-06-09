/**
 * @fileoverview Module-level accessor for the optional DataCanvas service.
 * The framework wires `core.canvas` onto CoreServices in createApp's setup()
 * callback — it is not exposed on Context — so handlers reach it through this
 * accessor. Present only when CANVAS_PROVIDER_TYPE=duckdb; undefined otherwise
 * (and always undefined on the Workers runtime, which has no DuckDB build).
 * @module services/canvas/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Store the DataCanvas instance from CoreServices. Called once in setup(). */
export const setCanvas = (c: DataCanvas | undefined): void => {
  _canvas = c;
};

/** The active DataCanvas, or undefined when canvas is disabled. */
export const getCanvas = (): DataCanvas | undefined => _canvas;

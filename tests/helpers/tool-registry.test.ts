/**
 * @fileoverview Guards the guard: `missingSelectorRows` must read every
 * endpoint selector a staging or cursor tool advertises, or a suite's table can
 * drop that selector's rows unnoticed.
 * @module tests/helpers/tool-registry.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { missingSelectorRows, toolsWithInput } from './tool-registry.js';

/*
 * Every enum input these tools advertise picks the endpoint they read, so a
 * table with no rows lacks one for each value of each. A tool that gains an
 * enum input fails here until the helper reads it as a selector.
 */
it.each(['stage', 'cursor'])(
  'missingSelectorRows reports every advertised enum value of the tools taking %s, given no rows',
  (inputKey) => {
    const tools = toolsWithInput(inputKey);
    const advertised = allToolDefinitions
      .filter((definition) => tools.includes(definition.name))
      .flatMap((definition) => {
        const { properties } = z.toJSONSchema(definition.input, { io: 'input' }) as {
          properties: Record<string, { enum?: unknown[] }>;
        };
        return Object.entries(properties).flatMap(([key, { enum: values = [] }]) =>
          values.map((value) => `${definition.name} ${key}=${String(value)}`),
        );
      });

    expect(advertised.length).toBeGreaterThan(0);
    expect(missingSelectorRows(inputKey, []).sort()).toEqual(advertised.sort());
  },
);

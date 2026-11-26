/**
 * @fileoverview Retry budget of the service's side requests — the past-end
 * total recovery (#47) and the `Nothing to count` confirm (#57) — against the
 * real `withRetry` under fake timers. Each side request runs inside the primary
 * request's retry callback, so it gets a single attempt: its own retries would
 * park a backoff sleep on the recovery's best-effort path, and multiply the
 * primary loop's budget on the confirm's failure path.
 * @module tests/services/openfda/openfda-service.side-requests.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenFdaService } from '@/services/openfda/openfda-service.js';
import { NO_MATCHES, NOTHING_TO_COUNT, UNAVAILABLE } from '../../helpers/upstream-responses.js';

const params = (url: string) => new URL(url).searchParams;

describe('OpenFdaService side requests', () => {
  const fetchMock = vi.fn<(input: string | URL | Request) => Promise<Response>>();
  const urls = () => fetchMock.mock.calls.map(([input]) => String(input));
  let service: OpenFdaService;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    service = new OpenFdaService({ baseUrl: 'https://api.fda.gov' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('settles a failed past-end recovery on its one attempt, with no backoff parked', async () => {
    fetchMock.mockImplementation(async (input) =>
      params(String(input)).get('limit') === '0' ? UNAVAILABLE() : NO_MATCHES(),
    );

    let settled = false;
    const pending = service
      .query(
        'drug/enforcement',
        { search: 'openfda.generic_name:"metformin"', limit: 1, skip: 39 },
        createMockContext(),
      )
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const result = await pending;
    expect(result.meta).toMatchObject({ total: 0, skip: 39, totalUnverified: true });
    const recoveries = urls().filter((url) => params(url).get('limit') === '0');
    expect(recoveries).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /*
   * #112 — a side request answered by a 200 that is not openFDA JSON fails as an
   * upstream_error like any other: the past-end recovery reports its total
   * unverified rather than reading the body as a verified zero, and a failed
   * confirm goes back to the primary loop rather than proving the expression
   * countable.
   */
  it('leaves the total unverified when the past-end recovery answers a 200 that is no envelope', async () => {
    fetchMock.mockImplementation(async (input) =>
      params(String(input)).get('limit') === '0' ? Response.json({}) : NO_MATCHES(),
    );

    const pending = service.query(
      'drug/enforcement',
      { search: 'openfda.generic_name:"metformin"', limit: 1, skip: 39 },
      createMockContext(),
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.meta).toMatchObject({ total: 0, skip: 39, totalUnverified: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails a confirm answered by a 200 that is no envelope through the primary loop', async () => {
    fetchMock.mockImplementation(async (input) =>
      params(String(input)).has('search')
        ? NOTHING_TO_COUNT()
        : new Response('<html><title>Gateway maintenance</title></html>', { status: 200 }),
    );

    const pending = service
      .query(
        'drug/enforcement',
        {
          search: '_missing_:openfda.generic_name',
          count: 'openfda.generic_name.exact',
          limit: 5,
        },
        createMockContext(),
      )
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await pending;

    expect(error).toMatchObject({
      data: { reason: 'upstream_error', endpoint: 'drug/enforcement', status: 200 },
    });
    const kinds = urls().map((url) => (params(url).has('search') ? 'scoped' : 'confirm'));
    expect(kinds).toEqual(Array.from({ length: 4 }, () => ['scoped', 'confirm']).flat());
  });

  it('leaves a failed confirm to the primary retry loop instead of retrying it in place', async () => {
    fetchMock.mockImplementation(async (input) =>
      params(String(input)).has('search') ? NOTHING_TO_COUNT() : UNAVAILABLE(),
    );

    const pending = service
      .query(
        'drug/enforcement',
        {
          search: '_missing_:openfda.generic_name',
          count: 'openfda.generic_name.exact',
          limit: 5,
        },
        createMockContext(),
      )
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await pending;

    expect(error).toMatchObject({ data: { reason: 'upstream_error' } });
    // Primary attempts (1 + 3 retries), each a scoped count then one confirm.
    const kinds = urls().map((url) => (params(url).has('search') ? 'scoped' : 'confirm'));
    expect(kinds).toEqual(Array.from({ length: 4 }, () => ['scoped', 'confirm']).flat());
  });
});

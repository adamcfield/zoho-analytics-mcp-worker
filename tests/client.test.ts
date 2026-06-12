import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ZohoAnalyticsClient,
  ZohoAnalyticsError,
  mapLimit,
  kvTokenStore,
  signDownloadToken,
  verifyDownloadToken,
} from "../src/zohoanalytics.js";

/** Client using a static access token — skips the OAuth refresh roundtrip. */
const mkStatic = () =>
  new ZohoAnalyticsClient({ accessToken: "tok", orgId: "o", dc: "com", backoffBaseMs: 1, maxRetries: 2 });

/** Client using refresh credentials — exercises the token endpoint. */
const mkRefresh = () =>
  new ZohoAnalyticsClient({
    clientId: "c",
    clientSecret: "s",
    refreshToken: "r",
    orgId: "o",
    dc: "com",
    backoffBaseMs: 1,
    maxRetries: 2,
  });

type Resp = { status: number; body: string; headers?: Record<string, string> };
/** fetch-shaped mock arg tuple so .mock.calls is typed (url, init). */
type FetchArgs = [input: string | URL, init?: RequestInit];
function mockSequence(responses: Resp[]) {
  let i = 0;
  return vi.fn(async (..._args: FetchArgs) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(r.body, { status: r.status, headers: r.headers });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("constructor", () => {
  it("throws without refresh creds or a static token", () => {
    expect(() => new ZohoAnalyticsClient({})).toThrow(/refreshToken|accessToken/);
  });
  it("throws on an unknown data center", () => {
    expect(() => new ZohoAnalyticsClient({ accessToken: "t", dc: "mars" })).toThrow(/data center/i);
  });
});

describe("request (JSON envelope)", () => {
  it("returns the parsed envelope on 200", async () => {
    vi.stubGlobal("fetch", mockSequence([{ status: 200, body: JSON.stringify({ status: "success", data: { orgs: [] } }) }]));
    expect(await mkStatic().getOrgs()).toMatchObject({ status: "success" });
  });

  it("throws ZohoAnalyticsError carrying status + errorCode on an HTTP 4xx envelope", async () => {
    vi.stubGlobal(
      "fetch",
      mockSequence([{ status: 400, body: JSON.stringify({ status: "failure", data: { errorCode: 7103, errorMessage: "no such view" } }) }]),
    );
    await expect(mkStatic().getWorkspaceDetails("w")).rejects.toMatchObject({
      name: "ZohoAnalyticsError",
      status: 400,
      errorCode: 7103,
    });
  });

  it("throws on a status:failure envelope even with HTTP 200", async () => {
    vi.stubGlobal(
      "fetch",
      mockSequence([{ status: 200, body: JSON.stringify({ status: "failure", data: { errorCode: 8504, errorMessage: "bad name" } }) }]),
    );
    await expect(mkStatic().getOrgs()).rejects.toMatchObject({ errorCode: 8504 });
  });

  it("retries an idempotent GET on 429, then succeeds", async () => {
    const f = mockSequence([
      { status: 429, body: "", headers: { "retry-after": "0" } },
      { status: 200, body: JSON.stringify({ status: "success", data: {} }) },
    ]);
    vi.stubGlobal("fetch", f);
    await mkStatic().getOrgs();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("never retries a write (no double-insert), even on 500", async () => {
    const f = mockSequence([{ status: 500, body: "boom" }]);
    vi.stubGlobal("fetch", f);
    await expect(mkStatic().addRow("w", "v", { columns: { a: 1 } })).rejects.toMatchObject({ status: 500 });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("CONFIG + headers", () => {
  it("URL-encodes CONFIG as a JSON query param and sends the auth + org headers", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify({ status: "success", data: { views: [] } }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().getViews("WS", { keyword: "sales" });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toContain("/restapi/v2/workspaces/WS/views");
    expect(String(url)).toContain("CONFIG=");
    expect(decodeURIComponent(String(url))).toContain('{"keyword":"sales"}');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Zoho-oauthtoken tok");
    expect(headers["ZANALYTICS-ORGID"]).toBe("o");
  });
});

describe("write transport (CONFIG placement)", () => {
  it("sends CONFIG in the form body (not the query) for writes", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().addRow("WS", "V", { columns: { a: 1 } });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).not.toContain("CONFIG=");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(decodeURIComponent(String(init?.body))).toContain('"columns":{"a":1}');
  });

  it("treats an empty 204 response as success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect(await mkStatic().deleteView("WS", "V")).toEqual({ status: "success" });
  });

  it("sends CONFIG in the form body for DELETE (destructive data ops)", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().deleteRows("WS", "V", { criteria: '"T"."C"=\'x\'' });
    const [url, init] = f.mock.calls[0];
    expect(init?.method).toBe("DELETE");
    expect(String(url)).not.toContain("CONFIG=");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(decodeURIComponent(String(init?.body))).toContain('"criteria"');
  });

  it("adds the ZANALYTICS-DEST-ORGID header for cross-org copies", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().copyViews("WS", { viewIds: ["v"], destWorkspaceId: "W2" }, "ORG2");
    expect(f.mock.calls[0][1]?.headers).toMatchObject({ "ZANALYTICS-DEST-ORGID": "ORG2" });
  });

  it("keeps CONFIG in the query string and sends FormData for multipart import", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify({ status: "success", data: { jobId: "1" } }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().createImportJob("WS", "V", { content: "a,b\n1,2", name: "import.csv" }, { importType: "append", fileType: "csv" });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toContain("CONFIG=");
    expect(init?.body instanceof FormData).toBe(true);
  });
});

describe("requestRaw (export / download)", () => {
  it("returns the raw body for a successful export", async () => {
    vi.stubGlobal("fetch", mockSequence([{ status: 200, body: "Region,Sales\nEast,100" }]));
    expect(await mkStatic().exportData("w", "v", { responseFormat: "csv" })).toBe("Region,Sales\nEast,100");
  });

  it("throws when the export comes back as a failure envelope", async () => {
    vi.stubGlobal(
      "fetch",
      mockSequence([{ status: 200, body: JSON.stringify({ status: "failure", data: { errorCode: 8120, errorMessage: "export failed" } }) }]),
    );
    await expect(mkStatic().exportData("w", "v", { responseFormat: "json" })).rejects.toMatchObject({ errorCode: 8120 });
  });

  it("throws with the HTTP status when an export fails with a non-envelope error body", async () => {
    vi.stubGlobal("fetch", mockSequence([{ status: 400, body: "bad request" }]));
    await expect(mkStatic().exportData("w", "v", { responseFormat: "csv" })).rejects.toMatchObject({
      name: "ZohoAnalyticsError",
      status: 400,
      body: "bad request",
    });
  });
});

describe("OAuth token refresh", () => {
  it("mints an access token via the accounts endpoint, then caches it", async () => {
    let tokenCalls = 0;
    const f = vi.fn(async (...[url]: FetchArgs) => {
      const u = String(url);
      if (u.includes("/oauth/v2/token")) {
        tokenCalls++;
        return new Response(JSON.stringify({ access_token: "AT1", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", f);
    const c = mkRefresh();
    await c.getOrgs();
    await c.getOrgs();
    expect(tokenCalls).toBe(1); // cached across the second call
    const tokenCall = f.mock.calls.find((call) => String(call[0]).includes("/oauth/v2/token"))!;
    // Credentials travel in the POST body — never the URL (query strings get logged).
    expect(String(tokenCall[0])).not.toContain("client_secret");
    expect(String(tokenCall[0])).not.toContain("refresh_token=");
    expect(String(tokenCall[1]?.body)).toContain("grant_type=refresh_token");
    expect(String(tokenCall[1]?.body)).toContain("client_secret=s");
    const apiCall = f.mock.calls.find((call) => String(call[0]).includes("/restapi/v2/orgs"))!;
    expect(apiCall[1]?.headers).toMatchObject({ Authorization: "Zoho-oauthtoken AT1" });
  });

  it("refreshes once and retries with the NEW token when the API returns 401", async () => {
    let tokenCalls = 0;
    let apiCalls = 0;
    const f = vi.fn(async (...[url]: FetchArgs) => {
      const u = String(url);
      if (u.includes("/oauth/v2/token")) {
        tokenCalls++;
        return new Response(JSON.stringify({ access_token: `AT${tokenCalls}`, expires_in: 3600 }), { status: 200 });
      }
      apiCalls++;
      if (apiCalls === 1) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", f);
    await mkRefresh().getOrgs();
    expect(tokenCalls).toBe(2); // initial mint + one refresh after 401
    expect(apiCalls).toBe(2); // 401, then retried success
    // The retried request must carry the freshly minted token, not replay the stale one.
    const orgCalls = f.mock.calls.filter((c) => String(c[0]).includes("/restapi/v2/orgs"));
    expect(orgCalls[1][1]?.headers).toMatchObject({ Authorization: "Zoho-oauthtoken AT2" });
  });

  it("deduplicates concurrent refreshes (single-flight): one token mint for a parallel batch", async () => {
    let tokenCalls = 0;
    const f = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/oauth/v2/token")) {
        tokenCalls++;
        await new Promise((r) => setTimeout(r, 5)); // let the other callers pile up
        return new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", f);
    const c = mkRefresh();
    await Promise.all([c.getOrgs(), c.getOrgs(), c.getOrgs()]);
    expect(tokenCalls).toBe(1);
  });

  it("surfaces an OAuth failure (error field with HTTP 200)", async () => {
    vi.stubGlobal("fetch", mockSequence([{ status: 200, body: JSON.stringify({ error: "invalid_code" }) }]));
    await expect(mkRefresh().getOrgs()).rejects.toThrow(/invalid_code/);
  });

  it("never calls the token endpoint when a static token is supplied", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().getOrgs();
    expect(f.mock.calls.some((call) => String(call[0]).includes("/oauth/v2/token"))).toBe(false);
  });
});

describe("data-center routing", () => {
  it("targets the EU domains when dc=eu", async () => {
    let tokenUrl = "";
    let apiUrl = "";
    const f = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/oauth/v2/token")) {
        tokenUrl = u;
        return new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 });
      }
      apiUrl = u;
      return new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", f);
    await new ZohoAnalyticsClient({ clientId: "c", clientSecret: "s", refreshToken: "r", dc: "eu", backoffBaseMs: 1 }).getOrgs();
    expect(tokenUrl).toContain("accounts.zoho.eu");
    expect(apiUrl).toContain("analyticsapi.zoho.eu");
  });
});

describe("mapLimit", () => {
  it("preserves input order and caps concurrency", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    const out = await mapLimit(items, 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return n * 2;
    });
    expect(out).toEqual(items.map((n) => n * 2));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });

  it("rejects if any task throws", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("full-coverage additions", () => {
  it("sync import posts multipart to the non-bulk path with CONFIG in the query", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().importDataSync("WS", "V", { content: "a\n1", name: "i.csv" }, { importType: "append" });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toContain("/restapi/v2/workspaces/WS/views/V/data?");
    expect(String(url)).not.toContain("/bulk/");
    expect(String(url)).toContain("CONFIG=");
    expect(init?.body instanceof FormData).toBe(true);
  });

  it("favorite toggles map to POST (add) and DELETE (remove)", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    const c = mkStatic();
    await c.setFavoriteView("W", "V", true);
    await c.setFavoriteView("W", "V", false);
    expect(String(f.mock.calls[0][0])).toContain("/workspaces/W/views/V/favorite");
    expect(f.mock.calls[0][1]?.method).toBe("POST");
    expect(f.mock.calls[1][1]?.method).toBe("DELETE");
  });

  it("template export returns the body base64-encoded", async () => {
    vi.stubGlobal("fetch", vi.fn(async (..._args: FetchArgs) => new Response("ZIPBYTES", { status: 200 })));
    expect(await mkStatic().exportAsTemplate("W", ["v1"])).toBe(btoa("ZIPBYTES"));
  });

  it("builds AutoML paths correctly", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().runAutoMLDeployment("W", "A", "D");
    expect(String(f.mock.calls[0][0])).toContain("/automl/workspaces/W/analysis/A/deployments/D/execute");
  });
});

describe("production hardening", () => {
  it("URL-encodes caller-supplied ids in API paths (no path injection)", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().getWorkspaceDetails("../bulk/evil?x=1");
    const url = String(f.mock.calls[0][0]);
    expect(url).toContain("/workspaces/..%2Fbulk%2Fevil%3Fx%3D1");
    expect(url).not.toContain("/workspaces/../");
  });

  it("batch import sends the mandatory batchKey/isLastBatch (single-batch defaults, caller-overridable)", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify({ status: "success", data: { jobId: "1" } }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().createBatchImportJob("W", "V", { content: "a\n1", name: "i.csv" }, { importType: "append" });
    const url1 = decodeURIComponent(String(f.mock.calls[0][0]));
    expect(url1).toContain('"batchKey":"start"');
    expect(url1).toContain('"isLastBatch":"true"');
    await mkStatic().createBatchImportJob("W", "V", { content: "b\n2", name: "i.csv" }, { batchKey: "k123", isLastBatch: "false" });
    const url2 = decodeURIComponent(String(f.mock.calls[1][0]));
    expect(url2).toContain('"batchKey":"k123"');
    expect(url2).toContain('"isLastBatch":"false"');
  });

  it("email-schedule writes are workspace-scoped and trigger has no /trigger suffix (live-docs paths)", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    const c = mkStatic();
    await c.createEmailSchedule("W", { scheduleName: "s" });
    await c.triggerEmailSchedule("W", "SID");
    await c.changeEmailScheduleStatus("W", "SID", { operation: "activate" });
    const urls = f.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain("/workspaces/W/emailschedules");
    expect(urls[0]).not.toContain("/views/");
    expect(urls[1]).toMatch(/\/workspaces\/W\/emailschedules\/SID$/);
    expect(urls[2]).toContain("/workspaces/W/emailschedules/SID/status");
  });

  it("datasource paths use the plural segment per Zoho's live docs", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().syncDatasource("W", "DS");
    expect(String(f.mock.calls[0][0])).toContain("/workspaces/W/datasources/DS/sync");
  });

  it("uses a shared token store: a stored valid token avoids the token endpoint entirely", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const store = {
      get: vi.fn(async () => ({ token: "STORED", expiry: Date.now() + 3_000_000 })),
      set: vi.fn(async () => {}),
    };
    const c = new ZohoAnalyticsClient({ clientId: "c", clientSecret: "s", refreshToken: "r", dc: "com", backoffBaseMs: 1, tokenStore: store });
    await c.getOrgs();
    expect(store.get).toHaveBeenCalled();
    expect(f.mock.calls.some((call) => String(call[0]).includes("/oauth/v2/token"))).toBe(false);
    expect(f.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Zoho-oauthtoken STORED" });
  });

  it("writes a freshly minted token back to the store", async () => {
    const f = vi.fn(async (...[url]: FetchArgs) => {
      if (String(url).includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "NEW", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", f);
    const store = { get: vi.fn(async () => null), set: vi.fn(async () => {}) };
    const c = new ZohoAnalyticsClient({ clientId: "c", clientSecret: "s", refreshToken: "r", dc: "com", backoffBaseMs: 1, tokenStore: store });
    await c.getOrgs();
    expect(store.set).toHaveBeenCalledWith("NEW", expect.any(Number));
  });
});

describe("sweep round 1 regressions", () => {
  it("401 with a poisoned shared store: bypasses the store, mints fresh, overwrites the store", async () => {
    let tokenCalls = 0;
    const f = vi.fn(async (...[url, init]: FetchArgs) => {
      if (String(url).includes("/oauth/v2/token")) {
        tokenCalls++;
        return new Response(JSON.stringify({ access_token: "FRESH", expires_in: 3600 }), { status: 200 });
      }
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === "Zoho-oauthtoken DEAD") return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 });
    });
    vi.stubGlobal("fetch", f);
    // Store keeps returning the dead token with a future expiry (server-side revocation).
    const store = {
      get: vi.fn(async () => ({ token: "DEAD", expiry: Date.now() + 3_000_000 })),
      set: vi.fn(async () => {}),
    };
    const c = new ZohoAnalyticsClient({ clientId: "c", clientSecret: "s", refreshToken: "r", dc: "com", backoffBaseMs: 1, tokenStore: store });
    await c.getOrgs(); // must self-heal: DEAD -> 401 -> fresh mint -> success
    expect(tokenCalls).toBe(1);
    expect(store.set).toHaveBeenCalledWith("FRESH", expect.any(Number)); // poisoned entry overwritten
    const orgCalls = f.mock.calls.filter((call) => String(call[0]).includes("/restapi/v2/orgs"));
    expect((orgCalls.at(-1)?.[1]?.headers as Record<string, string>).Authorization).toBe("Zoho-oauthtoken FRESH");
  });

  it("a throwing TokenStore.set does not fail the request (token already minted)", async () => {
    const f = vi.fn(async (...[url]: FetchArgs) => {
      if (String(url).includes("/oauth/v2/token")) {
        return new Response(JSON.stringify({ access_token: "T", expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "success", data: { ok: 1 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", f);
    const store = { get: vi.fn(async () => null), set: vi.fn(async () => { throw new Error("kv down"); }) };
    const c = new ZohoAnalyticsClient({ clientId: "c", clientSecret: "s", refreshToken: "r", dc: "com", backoffBaseMs: 1, tokenStore: store });
    await expect(c.getOrgs()).resolves.toMatchObject({ status: "success" });
  });

  it("sortData uses the CONFIG form-body transport (not a raw JSON body)", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().sortData("W", "V", { columns: ["123"], sortOrder: 1 });
    const [, init] = f.mock.calls[0];
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(decodeURIComponent(String(init?.body))).toContain('"sortOrder":1');
  });

  it("makeDefaultFolder uses PUT per the live docs", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().makeDefaultFolder("W", "F");
    expect(f.mock.calls[0][1]?.method).toBe("PUT");
    expect(String(f.mock.calls[0][0])).toContain("/folders/F/default");
  });

  it("key regeneration is never auto-retried (a retry could rotate twice)", async () => {
    const f = mockSequence([{ status: 500, body: "boom" }]);
    vi.stubGlobal("fetch", f);
    await expect(mkStatic().getWorkspaceSecretKey("W", { regenerateKey: true })).rejects.toMatchObject({ status: 500 });
    expect(f).toHaveBeenCalledTimes(1); // plain reads still retry; regeneration must not
  });

  it("refuses an oversized export via the declared Content-Length BEFORE reading the body", async () => {
    let bodyRead = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (..._args: FetchArgs) => {
        const res = new Response("x", { status: 200, headers: { "content-length": "999999999" } });
        // Instrument the read methods: the size guard must reject without calling either.
        res.text = async () => {
          bodyRead = true;
          return "x";
        };
        res.arrayBuffer = async () => {
          bodyRead = true;
          return new ArrayBuffer(1);
        };
        return res;
      }),
    );
    await expect(mkStatic().exportData("W", "V", { responseFormat: "csv" })).rejects.toThrow(/exceeds the 10MB limit/);
    expect(bodyRead).toBe(false); // the guard must fire before any body bytes are consumed
  });

  it("export-job creation (a state-creating GET) is never auto-retried", async () => {
    const f = mockSequence([{ status: 500, body: "boom" }]);
    vi.stubGlobal("fetch", f);
    await expect(mkStatic().createExportJobBySql("W", "select 1", "csv")).rejects.toMatchObject({ status: 500 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("share/remove are workspace-scoped; update-share is per-view (live-docs paths)", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", f);
    const c = mkStatic();
    await c.shareViews("W", { emailIds: ["a@x.com"], viewIds: ["v"], permissions: { read: true } });
    await c.removeShare("W", { emailIds: ["a@x.com"], removeAllViews: true });
    await c.updateSharedViews("W", "V1", { permissions: { read: true } });
    const urls = f.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toMatch(/\/workspaces\/W\/share$/);
    expect(urls[1]).toMatch(/\/workspaces\/W\/share$/);
    expect(urls[2]).toContain("/workspaces/W/views/V1/share");
    // Verbs matter as much as paths for this fix.
    expect(f.mock.calls[0][1]?.method).toBe("POST");
    expect(f.mock.calls[1][1]?.method).toBe("DELETE");
    expect(f.mock.calls[2][1]?.method).toBe("PUT");
  });

  it("getDatasources is workspace-scoped (live-docs path)", async () => {
    const f = vi.fn(async (..._args: FetchArgs) => new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await mkStatic().getDatasources("W");
    expect(String(f.mock.calls[0][0])).toMatch(/\/workspaces\/W\/datasources$/);
  });
});

describe("v1.6.0 additions", () => {
  it("kvTokenStore namespaces keys per user suffix", async () => {
    const store: Record<string, string> = {};
    const kv = {
      get: async (k: string) => (store[k] ? JSON.parse(store[k]) : null),
      put: async (k: string, v: string) => {
        store[k] = v;
      },
    } as never;
    const a = kvTokenStore(kv, "userA");
    const b = kvTokenStore(kv, "userB");
    const shared = kvTokenStore(kv);
    await a.set("TA", Date.now() + 3_000_000);
    await b.set("TB", Date.now() + 3_000_000);
    expect((await a.get())?.token).toBe("TA");
    expect((await b.get())?.token).toBe("TB");
    expect(await shared.get()).toBeNull(); // un-suffixed key untouched
    expect(Object.keys(store).sort()).toEqual([
      "zoho-analytics:access-token:userA",
      "zoho-analytics:access-token:userB",
    ]);
  });

  it("signed download tokens verify, reject tampering, and expire", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = await signDownloadToken("exp/abc", exp, "secret");
    expect(await verifyDownloadToken("exp/abc", exp, sig, "secret")).toBe(true);
    expect(await verifyDownloadToken("exp/OTHER", exp, sig, "secret")).toBe(false); // key tamper
    expect(await verifyDownloadToken("exp/abc", exp + 1, sig, "secret")).toBe(false); // exp tamper
    expect(await verifyDownloadToken("exp/abc", exp, sig, "wrong")).toBe(false); // wrong secret
    const past = Math.floor(Date.now() / 1000) - 10;
    const oldSig = await signDownloadToken("exp/abc", past, "secret");
    expect(await verifyDownloadToken("exp/abc", past, oldSig, "secret")).toBe(false); // expired
  });
});

describe("ZohoAnalyticsError", () => {
  it("includes method, path, status and errorCode in the message", () => {
    const e = new ZohoAnalyticsError(404, 7103, "not found", "GET", "/workspaces/x");
    expect(e.message).toContain("GET /workspaces/x");
    expect(e.message).toContain("404");
    expect(e.message).toContain("7103");
  });
});

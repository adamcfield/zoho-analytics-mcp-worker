import { describe, it, expect } from "vitest";
import { readableViewType, compactView, parseExportRows, extractColumns, capRows } from "../src/tools.js";

describe("readableViewType", () => {
  it("maps known view-type codes and passes through unknown", () => {
    expect(readableViewType(0)).toBe("Table");
    expect(readableViewType("6")).toBe("Query Table");
    expect(readableViewType(7)).toBe("Dashboard");
    expect(readableViewType(99)).toBe("type 99");
    expect(readableViewType(undefined)).toBe("type unknown");
  });
});

describe("compactView", () => {
  it("trims to id/name/type and resolves the readable type", () => {
    expect(compactView({ viewId: "v1", viewName: "Orders", viewType: 0, extra: "dropped" })).toEqual({
      viewId: "v1",
      viewName: "Orders",
      viewType: "Table",
      viewTypeCode: 0,
    });
  });
});

describe("parseExportRows", () => {
  it("handles a bare array", () => {
    expect(parseExportRows(JSON.stringify([{ a: 1 }, { a: 2 }])).rows).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it("handles the { data: [...] } keyValue form", () => {
    expect(parseExportRows(JSON.stringify({ data: [{ Region: "East" }] })).rows).toEqual([{ Region: "East" }]);
  });
  it("handles the { data: { rows: [...] } } form", () => {
    expect(parseExportRows(JSON.stringify({ data: { rows: [{ Region: "West" }] } })).rows).toEqual([{ Region: "West" }]);
  });
  it("rebuilds rows from column_order + rows arrays", () => {
    const body = JSON.stringify({ response: { result: { column_order: ["Region", "Sales"], rows: [["East", 100], ["West", 50]] } } });
    expect(parseExportRows(body).rows).toEqual([
      { Region: "East", Sales: 100 },
      { Region: "West", Sales: 50 },
    ]);
  });
  it("returns raw text when the body is not JSON", () => {
    const out = parseExportRows("Region,Sales\nEast,100");
    expect(out.rows).toEqual([]);
    expect(out.raw).toBe("Region,Sales\nEast,100");
  });
  it("returns raw json when the shape is unrecognized", () => {
    const out = parseExportRows(JSON.stringify({ status: "success", summary: "x" }));
    expect(out.rows).toEqual([]);
    expect(out.raw).toContain("success");
  });
});

describe("extractColumns", () => {
  it("pulls columns from data.views.columns with Zoho's UPPERCASE keys", () => {
    const env = { data: { views: { columns: [{ COLUMNNAME: "Region", DATATYPE: "PLAIN" }, { COLUMNNAME: "Sales", DATATYPE: "NUMBER" }] } } };
    expect(extractColumns(env)).toEqual([
      { columnName: "Region", dataType: "PLAIN" },
      { columnName: "Sales", dataType: "NUMBER" },
    ]);
  });
  it("tolerates lowercase keys and an alternative nesting", () => {
    const env = { views: { columns: [{ columnName: "id", dataType: "AUTO_NUMBER" }] } };
    expect(extractColumns(env)).toEqual([{ columnName: "id", dataType: "AUTO_NUMBER" }]);
  });
  it("returns [] when no columns are present", () => {
    expect(extractColumns({ data: { views: {} } })).toEqual([]);
    expect(extractColumns({})).toEqual([]);
  });
  it("drops entries without a column name", () => {
    expect(extractColumns({ data: { views: { columns: [{ DATATYPE: "PLAIN" }, { COLUMNNAME: "ok" }] } } })).toEqual([
      { columnName: "ok", dataType: null },
    ]);
  });
});

describe("capRows", () => {
  it("reports total and truncation when over the cap", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ i }));
    const out = capRows(rows, 3);
    expect(out.total).toBe(5);
    expect(out.truncated).toBe(true);
    expect(out.rows).toHaveLength(3);
  });
  it("passes through when under the cap", () => {
    const out = capRows([{ i: 1 }], 10);
    expect(out.truncated).toBe(false);
    expect(out.total).toBe(1);
    expect(out.rows).toHaveLength(1);
  });
});

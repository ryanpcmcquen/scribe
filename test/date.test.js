"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { currentMonth, isDate, isMonth, localDate } = require("../dist/date.js");

test("localDate uses local calendar fields", () => {
  // Nov 4 2026, 11:30pm local
  const date = new Date(2026, 10, 4, 23, 30);
  assert.equal(localDate(date), "2026-11-04");
  assert.equal(currentMonth(date), "2026-11");
});

test("isDate validates real calendar dates", () => {
  assert.equal(isDate("2026-11-04"), true);
  assert.equal(isDate("2024-02-29"), true);

  assert.equal(isDate("2026-02-30"), false);
  assert.equal(isDate("2026-13-01"), false);
  assert.equal(isDate("2026-00-10"), false);
  assert.equal(isDate("2026-11-0"), false);
  assert.equal(isDate("11-04-2026"), false);
});

test("isMonth validates month numbers", () => {
  assert.equal(isMonth("2026-11"), true);
  assert.equal(isMonth("2026-01"), true);

  assert.equal(isMonth("2026-13"), false);
  assert.equal(isMonth("2026-00"), false);
  assert.equal(isMonth("2026-1"), false);
  assert.equal(isMonth("2026-11-04"), false);
});

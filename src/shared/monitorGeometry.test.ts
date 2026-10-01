import { describe, expect, it } from "vitest";
import { monitorRect, workAreaAtPoint } from "./monitorGeometry.js";

const primary = { position: { x: 0, y: 0 }, size: { width: 2880, height: 1800 }, scaleFactor: 2,
  workArea: { position: { x: 0, y: 50 }, size: { width: 2880, height: 1650 } } };
const secondary = { position: { x: -1920, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1,
  workArea: { position: { x: -1920, y: 0 }, size: { width: 1920, height: 1040 } } };
describe("monitor geometry", () => {
  it("keeps display bounds separate from menu and dock reservations", () => {
    expect(monitorRect(primary)).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    expect(monitorRect(primary, true)).toEqual({ x: 0, y: 25, width: 1440, height: 825 });
  });
  it("selects the target pet's screen including negative coordinates", () => {
    expect(workAreaAtPoint([primary, secondary], { x: -500, y: 100 })).toEqual(monitorRect(secondary, true));
    expect(workAreaAtPoint([primary, secondary], { x: 500, y: 100 })).toEqual(monitorRect(primary, true));
  });
  it("uses the nearest connected monitor for an offscreen target and tolerates an empty list", () => {
    expect(workAreaAtPoint([primary, secondary], { x: -2300, y: 100 })).toEqual(monitorRect(secondary, true));
    expect(workAreaAtPoint([], { x: 0, y: 0 })).toBeNull();
  });
});

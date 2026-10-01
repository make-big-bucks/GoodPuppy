import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";

// 对照实际窗口 API 调用与 capability，防止 UI 编译正常但原生拒绝命令。
const permissions: Record<string, string> = {
  show: "allow-show", hide: "allow-hide", setSize: "allow-set-size", setMinSize: "allow-set-min-size",
  minimize: "allow-minimize", toggleMaximize: "allow-internal-toggle-maximize",
};
describe("lounge window command permissions", () => {
  it("authorizes every window mutation used by its entry point", () => {
    const source = ts.createSourceFile("lounge-main.ts", readFileSync("src/windows/lounge/lounge-main.ts", "utf8"), ts.ScriptTarget.Latest, true);
    const capability = JSON.parse(readFileSync("src-tauri/capabilities/lounge.json", "utf8"));
    const used = new Set<string>();
    function walk(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const permission = permissions[node.expression.name.text];
        if (permission) used.add(`core:window:${permission}`);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
    expect(used.size).toBeGreaterThan(0);
    for (const permission of used) expect(capability.permissions, permission).toContain(permission);
  });
});

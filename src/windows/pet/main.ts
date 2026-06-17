import "../../shared/bridge.js";
import "../../shared/styles.css";

// pet.html 同时服务两种窗口：
// - "main"         → 自己的 pet + 房间协调者（selfMain）。
// - "pet-<userId>" → 某个远程成员的独立呈现器（remotePresenterMain）。
// 按窗口 label 分派，避免远程窗口启动 Supabase 订阅。
const label = window.goodPuppy.getWindowLabel();

if (label.startsWith("pet-")) {
  void import("./remotePresenterMain.js");
} else {
  void import("./selfMain.js");
}

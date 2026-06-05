// 顺序重要：bridge 必须先于 renderer 执行（renderer 顶层会读 window.goodPuppy）
import "./bridge.js";
import "./styles.css";
import "./renderer.js";

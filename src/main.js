// 顺序重要：bridge 必须先于 renderer 执行（renderer 顶层会读 window.goodPuppy）
import "./bridge.js";
import "./styles.css";
import { initializeAuth } from "./auth.js";
import { startPetApp } from "./renderer.js";

initializeAuth(startPetApp).catch((error) => {
  console.error(error);
});

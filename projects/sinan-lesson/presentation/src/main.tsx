// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ORIENTATION } from "./stage.config";

// 把项目级 orientation 挂到 <html> 上，让 base.css 的
// :root[data-orientation="..."] 选段能命中 —— mount 前同步执行，
// 避免横屏 token 在首帧被竖屏 frame 错位。
document.documentElement.setAttribute("data-orientation", ORIENTATION);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

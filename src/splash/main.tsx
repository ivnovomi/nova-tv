import React from "react";
import ReactDOM from "react-dom/client";
import { MotionConfig } from "motion/react";
import { Splash } from "./Splash";
import "../styles.css";

// NOVA scales its type with the TV's size; this small window has a fixed one.
document.documentElement.style.fontSize = "15px";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <Splash />
    </MotionConfig>
  </React.StrictMode>,
);

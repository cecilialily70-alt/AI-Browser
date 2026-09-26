import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./app/App";
import "./styles/globals.css";

document.addEventListener(
  "contextmenu",
  (event) => {
    event.preventDefault();
  },
  { capture: true },
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

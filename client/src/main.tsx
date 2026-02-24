import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { CopilotKitShell } from "./copilotkit/CopilotKitShell";

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CopilotKitShell>
      <App />
    </CopilotKitShell>
  </StrictMode>,
)

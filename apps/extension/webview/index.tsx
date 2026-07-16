import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "@vscode/codicons/dist/codicon.css";
import "./styles.css";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

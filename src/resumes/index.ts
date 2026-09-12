/**
 * Canonical resume view model and renderers (R4-D). One view model feeds
 * the Markdown, DOCX, and HTML/PDF projections; parity checks compare
 * every projection against the model before review.
 */
export * from "./artifacts";
export * from "./checks";
export * from "./config";
export * from "./docx";
export * from "./markdown";
export * from "./pdf";
export * from "./template";
export * from "./viewModel";

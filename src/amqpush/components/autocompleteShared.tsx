import { EditorView } from "@codemirror/view";

/**
 * CodeMirror theme for the `{{token}}` autocomplete popup. Used by both the
 * body editor (`CodeEditor`) and the single-line `TokenInput` so the popup
 * looks identical regardless of which input invokes it.
 *
 * Since both consumers are CodeMirror instances now (the previous custom
 * HTML popup is gone), we only need the editor-side theme — no React popup
 * component lives here anymore.
 */

const FONT_FAMILY = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
const FONT_SIZE   = "12px";
const RADIUS      = "6px";
const SHADOW      = "0 4px 12px rgba(0,0,0,0.15)";
const ROW_PADDING = "3px 8px";
const MAX_HEIGHT  = "240px";
const MIN_WIDTH   = "180px";
const INFO_WIDTH  = "320px";
const INFO_FONT   = "11px";

export const cmAutocompleteTheme = EditorView.baseTheme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    background:   "rgb(var(--t-card))",
    border:       "1px solid rgb(var(--t-line))",
    borderRadius: RADIUS,
    boxShadow:    SHADOW,
    color:        "rgb(var(--t-ink))",
    fontFamily:   FONT_FAMILY,
    fontSize:     FONT_SIZE,
    minWidth:     MIN_WIDTH,
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "inherit",
    maxHeight:  MAX_HEIGHT,
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: ROW_PADDING,
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "rgb(var(--t-selection) / 0.18)",
    color:      "rgb(var(--t-ink))",
  },
  ".cm-completionLabel":  { color: "rgb(var(--t-ink2))" },
  ".cm-completionDetail": {
    color:      "rgb(var(--t-ink5))",
    fontStyle:  "italic",
    marginLeft: "8px",
  },
  ".cm-completionInfo": {
    background:   "rgb(var(--t-panel))",
    border:       "1px solid rgb(var(--t-line))",
    borderRadius: RADIUS,
    color:        "rgb(var(--t-ink2))",
    padding:      "6px 8px",
    fontSize:     INFO_FONT,
    maxWidth:     INFO_WIDTH,
    boxShadow:    SHADOW,
  },
});

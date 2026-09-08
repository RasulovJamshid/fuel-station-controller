type PrintDocumentOptions = {
  rootId: string;
  styleId: string;
  html: string;
  css: string;
};

const nextPaint = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Mounts a print-only document and keeps it alive until the system print flow
 * has finished. Webviews can open their native print dialog asynchronously, so
 * removing the content on a short timer can produce a blank or clipped report.
 */
export async function printHtmlDocument({ rootId, styleId, html, css }: PrintDocumentOptions) {
  document.getElementById(rootId)?.remove();
  document.getElementById(styleId)?.remove();

  const root = document.createElement("div");
  root.id = rootId;
  root.innerHTML = html;
  document.body.appendChild(root);

  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = css;
  document.head.appendChild(style);

  const printMedia = window.matchMedia("print");
  let enteredPrintMode = false;
  let fallbackTimer: number | undefined;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
    document.getElementById(rootId)?.remove();
    document.getElementById(styleId)?.remove();
    window.removeEventListener("afterprint", cleanup);
    printMedia.removeEventListener("change", onPrintMediaChange);
  };

  const onPrintMediaChange = (event: MediaQueryListEvent) => {
    if (event.matches) {
      enteredPrintMode = true;
    } else if (enteredPrintMode) {
      cleanup();
    }
  };

  window.addEventListener("afterprint", cleanup);
  printMedia.addEventListener("change", onPrintMediaChange);

  try {
    await document.fonts.ready;
    await nextPaint();
    await nextPaint();

    // Keep the hidden report available if a platform does not emit afterprint.
    // It has no effect on the normal UI and is removed after five minutes.
    fallbackTimer = window.setTimeout(cleanup, 300_000);
    window.print();
  } catch (error) {
    cleanup();
    throw error;
  }
}

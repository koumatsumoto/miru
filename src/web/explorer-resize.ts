const preference = "miru.explorer-width";

export function bindExplorerResize(handle: HTMLElement) {
  const layout = handle.parentElement!;
  const styles = getComputedStyle(layout);
  const minimum = Number.parseInt(styles.getPropertyValue("--explorer-min"), 10);
  const defaultWidth = Number.parseInt(styles.getPropertyValue("--explorer-default"), 10);
  const maximum = () =>
    Math.max(minimum, Math.floor(Math.min(layout.clientWidth * 0.6, layout.clientWidth - 320)));
  let preferred = defaultWidth;
  try {
    const saved = Number(localStorage.getItem(preference));
    if (Number.isFinite(saved) && saved >= minimum) preferred = saved;
  } catch {
    // The splitter still works when browser storage is unavailable.
  }
  let width = defaultWidth;
  let drag: { id: number; startX: number; startWidth: number } | undefined;
  function display(requested: number) {
    const max = maximum();
    width = Math.round(Math.max(minimum, Math.min(max, requested)));
    layout.style.setProperty("--explorer-width", width + "px");
    handle.setAttribute("aria-valuemin", String(minimum));
    handle.setAttribute("aria-valuemax", String(max));
    handle.setAttribute("aria-valuenow", String(width));
  }
  function remember() {
    preferred = width;
    try {
      localStorage.setItem(preference, String(width));
    } catch {
      // Keep the in-memory preference.
    }
  }
  window.addEventListener("resize", () => display(drag ? width : preferred));
  display(preferred);
  handle.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, startX: event.clientX, startWidth: width };
    layout.dataset.resizing = "";
  });
  handle.addEventListener("pointermove", (event) => {
    if (drag?.id !== event.pointerId) return;
    display(drag.startWidth + event.clientX - drag.startX);
  });
  // Pointer capture also ends on pointerup or pointercancel outside the window.
  handle.addEventListener("lostpointercapture", (event) => {
    if (drag?.id !== event.pointerId) return;
    drag = undefined;
    delete layout.dataset.resizing;
    remember();
  });
  handle.addEventListener("keydown", (event) => {
    if (drag) return;
    const step = event.shiftKey ? 48 : 12;
    const next =
      event.key === "ArrowLeft"
        ? width - step
        : event.key === "ArrowRight"
          ? width + step
          : event.key === "Home"
            ? minimum
            : event.key === "End"
              ? maximum()
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    display(next);
    remember();
  });
}

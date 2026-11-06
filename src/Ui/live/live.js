"use strict";

(() => {
  const REFRESH_MS = 1000;
  const logBox = Ui.byId("logBox");
  let loading = false;

  function setText(text) {
    const scrollTop = logBox.scrollTop;
    const scrollLeft = logBox.scrollLeft;
    logBox.value = text;
    logBox.scrollTop = scrollTop;
    logBox.scrollLeft = scrollLeft;
  }

  async function refresh() {
    if (loading)
      return;
    loading = true;
    try {
      setText(await Ui.invoke("live:table"));
    } catch (error) {
      if (!error.canceled)
        setText(error.message);
    } finally {
      loading = false;
    }
  }

  Ui.byId("closeButton").addEventListener("click", () => window.close());
  document.addEventListener("keydown", event => {
    if (event.key === "Escape")
      window.close();
  });

  refresh().then(() => setInterval(refresh, REFRESH_MS));
})();

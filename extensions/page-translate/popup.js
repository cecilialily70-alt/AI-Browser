document.getElementById("translate-btn").addEventListener("click", function () {
  chrome.runtime.sendMessage({ type: "translate-active-tab" }, function () {
    window.close();
  });
});

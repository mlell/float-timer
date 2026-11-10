// Register offline caching in normal browser tabs and check again on reconnection.
export async function registerOffline(): Promise<void> {
  if (
    !["https:", "http:"].includes(location.protocol) ||
    !("serviceWorker" in navigator)
  ) {
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register(
      new URL("./service-worker.js", import.meta.url),
      { updateViaCache: "none" },
    );
    window.addEventListener("online", () => {
      void registration.update().catch((error: unknown) => {
        console.warn("Could not check for an offline app update", error);
      });
    });
  } catch (error: unknown) {
    // Storage restrictions or offline first visits must not prevent timer use.
    console.warn("Offline caching is unavailable", error);
  }
}

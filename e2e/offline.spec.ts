// Exercise release caching and worker lifecycles on isolated subdirectory origins.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  expect,
  test as base,
  type BrowserContext,
  type Page,
} from "@playwright/test";

const shell = ["index.html", "main.js", "styles.css"];

interface Release {
  assets: Map<string, Buffer>;
  version: string;
}

interface ReleaseBrowser {
  context: BrowserContext;
  page: Page;
  scope: string;
  initial: Release;
  updated: Release;
  publish: (release: Release) => void;
}

const test = base.extend<{ releaseBrowser: ReleaseBrowser }>({
  releaseBrowser: async ({ browser }, use) => {
    const assets = new Map<string, Buffer>(
      await Promise.all(
        [...shell, "service-worker.js"].map(async (name) => {
          const content = await readFile(
            new URL(`../dist/${name}`, import.meta.url),
          );
          return [name, content] satisfies [string, Buffer];
        }),
      ),
    );
    const initial: Release = { assets, version: releaseVersion(assets) };
    const updatedAssets = new Map(assets);
    const html = requiredAsset(assets, "index.html").toString();
    expect(html).toContain("<title>Timer</title>");
    updatedAssets.set(
      "index.html",
      Buffer.from(
        html.replace("<title>Timer</title>", "<title>Timer release 2</title>"),
      ),
    );
    const updated = {
      assets: updatedAssets,
      version: releaseVersion(updatedAssets),
    };
    const worker = requiredAsset(assets, "service-worker.js").toString();
    expect(worker).toContain(initial.version);
    updatedAssets.set(
      "service-worker.js",
      Buffer.from(worker.replace(initial.version, updated.version)),
    );

    let current = initial;
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const name = pathname === "/timer/" ? "index.html" : pathname.slice(7);
      const content = pathname.startsWith("/timer/")
        ? current.assets.get(name)
        : undefined;
      response.setHeader("Cache-Control", "no-store");
      if (content === undefined) {
        response.writeHead(404).end();
        return;
      }
      const contentType = name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : "text/html";
      response.setHeader("Content-Type", contentType);
      response.end(content);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected an ephemeral HTTP port");
      }
      const origin = `http://127.0.0.1:${String(address.port)}`;
      const context = await browser.newContext({ baseURL: origin });
      try {
        await use({
          context,
          page: await context.newPage(),
          scope: `${origin}/timer/`,
          initial,
          updated,
          publish: (release) => {
            current = release;
          },
        });
      } finally {
        await context.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      });
    }
  },
});

function requiredAsset(assets: Map<string, Buffer>, name: string): Buffer {
  const content = assets.get(name);
  if (content === undefined) throw new Error(`Missing build asset: ${name}`);
  return content;
}

function releaseVersion(assets: Map<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const name of shell) hash.update(requiredAsset(assets, name));
  return hash.digest("hex");
}

async function openControlled(page: Page): Promise<void> {
  await page.goto("/timer/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller !== null) return;
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        () => {
          resolve();
        },
        {
          once: true,
        },
      );
    });
  });
  await expect(page.getByRole("timer")).toHaveText("0");
}

test("normal tabs cache the complete scoped shell and reload offline", async ({
  releaseBrowser: { context, page, scope, initial },
}) => {
  // Seed before registration so activation must preserve other owners' caches.
  await page.goto("/timer/missing");
  const protectedNames = [
    "unrelated-cache",
    `timer-shell:${new URL("/other/", scope).href}:old`,
  ];
  const staleName = `timer-shell:${scope}:old`;
  await page.evaluate(
    async (names) => {
      for (const name of names) {
        const cache = await caches.open(name);
        await cache.put("/sentinel", new Response(name));
      }
    },
    [...protectedNames, staleName],
  );

  await openControlled(page);
  expect(
    await page.evaluate(() => matchMedia("(display-mode: standalone)").matches),
  ).toBe(false);
  expect(
    await page.evaluate(
      async () => (await navigator.serviceWorker.ready).scope,
    ),
  ).toBe(scope);
  const cacheName = `timer-shell:${scope}:${initial.version}`;
  expect(await page.evaluate(() => caches.keys())).toEqual(
    expect.arrayContaining([...protectedNames, cacheName]),
  );
  expect(await page.evaluate(() => caches.keys())).not.toContain(staleName);
  expect(
    await page.evaluate(async (name) => {
      const cache = await caches.open(name);
      return (await cache.keys()).map((request) => request.url).sort();
    }, cacheName),
  ).toEqual(shell.map((name) => new URL(name, scope).href).sort());
  expect(
    await page.evaluate(
      async (names) =>
        Promise.all(
          names.map(async (name) => {
            const response = await (await caches.open(name)).match("/sentinel");
            return response?.text();
          }),
        ),
      protectedNames,
    ),
  ).toEqual(protectedNames);

  await context.setOffline(true);
  // Disabling the HTTP cache ensures this reload actually needs the worker's shell.
  await page.route("**/*", (route) => route.continue());
  const response = await page.reload();
  expect(response?.fromServiceWorker()).toBe(true);
  await expect(page.getByRole("timer")).toHaveText("0");
  await page.getByRole("button", { name: "Add 1 minute", exact: true }).click();
  await expect(page.getByRole("timer")).toHaveText("1");
  expect(
    await page.locator("#app").evaluate((app) => getComputedStyle(app).display),
  ).toBe("flex");
  await page.goto("/timer/index.html?offline=1");
  await expect(page.getByRole("timer")).toBeVisible();
});

test("reconnection installs an update without reload and waits for all old tabs to close", async ({
  releaseBrowser: { context, page, scope, initial, updated, publish },
}) => {
  await openControlled(page);
  const secondTab = await context.newPage();
  await openControlled(secondTab);
  await page.getByRole("button", { name: "Add 1 minute", exact: true }).click();
  await page.evaluate(() => {
    document.documentElement.dataset.offlineTest = "original document";
  });

  await context.setOffline(true);
  publish(updated);
  // Arm updatefound before reconnection to exercise offline.ts, not a manual update().
  const candidate = await page.evaluateHandle(async () => {
    const registration = await navigator.serviceWorker.ready;
    return {
      found: new Promise<ServiceWorker>((resolve, reject) => {
        registration.addEventListener(
          "updatefound",
          () => {
            const worker = registration.installing;
            if (worker === null) reject(new Error("No installing update"));
            else resolve(worker);
          },
          { once: true },
        );
      }),
    };
  });
  await context.setOffline(false);
  await candidate.evaluate(async ({ found }) => {
    const worker = await found;
    if (worker.state === "installed") return;
    await new Promise<void>((resolve, reject) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed") resolve();
        if (worker.state === "redundant")
          reject(new Error("Update installation failed"));
      });
    });
  });
  expect(
    await page.evaluate(
      async () => (await navigator.serviceWorker.ready).waiting?.state,
    ),
  ).toBe("installed");
  await expect(page).toHaveTitle("Timer");
  await expect(page.getByRole("timer")).toHaveText("1");
  await expect(page.locator("html")).toHaveAttribute(
    "data-offline-test",
    "original document",
  );
  await candidate.dispose();

  await page.close();
  expect(
    await secondTab.evaluate(
      async () => (await navigator.serviceWorker.ready).waiting?.state,
    ),
  ).toBe("installed");
  // Observe activation from outside the worker scope without keeping an old client alive.
  const observer = await context.newPage();
  await observer.goto("/observer");
  const activation = await observer.evaluateHandle(async (url) => {
    const registration = await navigator.serviceWorker.getRegistration(url);
    const worker = registration?.waiting;
    if (!worker) throw new Error("Expected the update to remain waiting");
    return worker;
  }, scope);
  await secondTab.close();
  await activation.evaluate(async (worker) => {
    if (worker.state === "activated") return;
    await new Promise<void>((resolve) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
      });
    });
  });
  await activation.dispose();
  expect(await observer.evaluate(() => caches.keys())).toContain(
    `timer-shell:${scope}:${updated.version}`,
  );
  expect(await observer.evaluate(() => caches.keys())).not.toContain(
    `timer-shell:${scope}:${initial.version}`,
  );
  await context.setOffline(true);
  const nextTab = await context.newPage();
  await nextTab.goto("/timer/");
  await expect(nextTab).toHaveTitle("Timer release 2");
  await expect(nextTab.getByRole("timer")).toHaveText("0");
});

test("an incomplete update fails installation and leaves the old release usable offline", async ({
  releaseBrowser: { context, page, scope, initial, updated, publish },
}) => {
  await openControlled(page);
  const incomplete = new Map(updated.assets);
  incomplete.delete("styles.css");
  publish({ assets: incomplete, version: updated.version });
  const failedState = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const failure = new Promise<string>((resolve) => {
      registration.addEventListener(
        "updatefound",
        () => {
          const worker = registration.installing;
          if (worker === null) throw new Error("No installing update");
          worker.addEventListener("statechange", () => {
            if (worker.state === "redundant") resolve(worker.state);
          });
        },
        { once: true },
      );
    });
    await registration.update();
    return failure;
  });
  expect(failedState).toBe("redundant");
  expect(
    await page.evaluate(
      async () => (await navigator.serviceWorker.ready).waiting,
    ),
  ).toBeNull();
  expect(await page.evaluate(() => caches.keys())).toContain(
    `timer-shell:${scope}:${initial.version}`,
  );
  await context.setOffline(true);
  await page.reload();
  await expect(page).toHaveTitle("Timer");
  await page.getByRole("button", { name: "Add 1 minute", exact: true }).click();
  await expect(page.getByRole("timer")).toHaveText("1");
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewAeryVersion,
	comparePackageVersions,
	getLatestAeryRelease,
	getLatestAeryVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.js";

const originalSkipVersionCheck = process.env.AERY_SKIP_VERSION_CHECK;
const originalOffline = process.env.AERY_OFFLINE;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.AERY_SKIP_VERSION_CHECK;
	} else {
		process.env.AERY_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.AERY_OFFLINE;
	} else {
		process.env.AERY_OFFLINE = originalOffline;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewAeryVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewAeryVersion("1.2.2")).resolves.toBe("1.2.3");
	});

	it("uses the eminent337.github.io version check api with an aery user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestAeryVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://eminent337.github.io/api/latest-version",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^aery\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("returns the active package name from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ packageName: "@new-scope/pi", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestAeryRelease("1.2.3")).resolves.toEqual({ packageName: "@new-scope/pi", version: "1.2.4" });
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.AERY_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestAeryVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

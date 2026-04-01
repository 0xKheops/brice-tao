import { afterEach, describe, expect, it, vi } from "bun:test";
import type { StakeEntry } from "../balances/getBalances.ts";
import { TAO } from "../rebalance/tao.ts";
import * as pickValidatorModule from "./pickBestValidator.ts";
import { resolveValidators } from "./resolveValidators.ts";

function hotkey(id: string): string {
	return `5${id.padEnd(47, "a")}`;
}

function makeStake(
	partial: Partial<StakeEntry> & Pick<StakeEntry, "netuid">,
): StakeEntry {
	const taoValue = partial.taoValue ?? TAO;
	return {
		netuid: partial.netuid,
		hotkey: partial.hotkey ?? hotkey(String(partial.netuid)),
		stake: partial.stake ?? TAO,
		alphaPrice: partial.alphaPrice ?? TAO,
		taoValue,
	};
}

const fakeApi = {} as Parameters<typeof resolveValidators>[0];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("resolveValidators existing position reuse", () => {
	it("reuses the largest existing position hotkey on a target subnet", async () => {
		const pickSpy = vi.spyOn(pickValidatorModule, "pickBestValidatorByYield");
		const stakes = [
			makeStake({ netuid: 7, hotkey: hotkey("small"), taoValue: TAO }),
			makeStake({
				netuid: 7,
				hotkey: hotkey("large"),
				taoValue: 2n * TAO,
			}),
		];

		const { hotkeysByTarget } = await resolveValidators(fakeApi, stakes, [7]);

		expect(pickSpy).not.toHaveBeenCalled();
		expect(hotkeysByTarget.get(7)).toBe(hotkey("large"));
	});

	it("breaks equal-value ties by higher stake then alphabetically", async () => {
		const stakes = [
			makeStake({
				netuid: 9,
				hotkey: "5beta".padEnd(48, "b"),
				taoValue: TAO,
				stake: TAO,
			}),
			makeStake({
				netuid: 9,
				hotkey: "5alpha".padEnd(48, "a"),
				taoValue: TAO,
				stake: TAO,
			}),
		];

		const { hotkeysByTarget } = await resolveValidators(fakeApi, stakes, [9]);

		expect(hotkeysByTarget.get(9)).toBe("5alpha".padEnd(48, "a"));
	});
});

describe("resolveValidators yield-based selection", () => {
	it("picks the best validator by yield when no existing position exists", async () => {
		vi.spyOn(pickValidatorModule, "pickBestValidatorByYield").mockResolvedValue(
			{
				hotkey: hotkey("yield-best"),
				candidate: {
					uid: 1,
					hotkey: hotkey("yield-best"),
					alphaStake: TAO,
					alphaDividends: 1n,
					yieldPerAlpha: 1,
				},
			},
		);

		const { hotkeysByTarget, skipped } = await resolveValidators(
			fakeApi,
			[],
			[42],
		);

		expect(hotkeysByTarget.get(42)).toBe(hotkey("yield-best"));
		expect(skipped).toHaveLength(0);
	});
});

describe("resolveValidators fallback and skip behavior", () => {
	it("falls back to provided hotkey when yield selection fails", async () => {
		vi.spyOn(pickValidatorModule, "pickBestValidatorByYield").mockRejectedValue(
			new Error("Subnet 33 not found"),
		);

		const { hotkeysByTarget, skipped } = await resolveValidators(
			fakeApi,
			[],
			[33],
			hotkey("fallback"),
		);

		expect(hotkeysByTarget.get(33)).toBe(hotkey("fallback"));
		expect(skipped).toHaveLength(0);
	});

	it("records a skip when yield selection fails and no fallback is provided", async () => {
		vi.spyOn(pickValidatorModule, "pickBestValidatorByYield").mockRejectedValue(
			new Error("Subnet 33 not found"),
		);

		const { hotkeysByTarget, skipped } = await resolveValidators(
			fakeApi,
			[],
			[33],
		);

		expect(hotkeysByTarget.has(33)).toBe(false);
		expect(skipped).toContainEqual({
			netuid: 33,
			reason: "No validator selected for SN33: Subnet 33 not found",
		});
	});

	it("resolves multiple targets with mixed strategies", async () => {
		vi.spyOn(pickValidatorModule, "pickBestValidatorByYield").mockResolvedValue(
			{
				hotkey: hotkey("yield-pick"),
				candidate: {
					uid: 1,
					hotkey: hotkey("yield-pick"),
					alphaStake: TAO,
					alphaDividends: 1n,
					yieldPerAlpha: 1,
				},
			},
		);

		const stakes = [makeStake({ netuid: 5, hotkey: hotkey("existing") })];

		const { hotkeysByTarget } = await resolveValidators(
			fakeApi,
			stakes,
			[5, 10],
		);

		expect(hotkeysByTarget.get(5)).toBe(hotkey("existing"));
		expect(hotkeysByTarget.get(10)).toBe(hotkey("yield-pick"));
	});
});

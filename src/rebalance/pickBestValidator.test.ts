import { describe, expect, it } from "bun:test";
import { pickBestValidatorByYield } from "./pickBestValidator.ts";

type PickApi = Parameters<typeof pickBestValidatorByYield>[0];
type SelectiveMetagraph = Awaited<
	ReturnType<PickApi["apis"]["SubnetInfoRuntimeApi"]["get_selective_metagraph"]>
>;

function makeApi(meta: SelectiveMetagraph): PickApi {
	return {
		apis: {
			SubnetInfoRuntimeApi: {
				get_selective_metagraph: async () => meta,
			},
		},
	} as unknown as PickApi;
}

describe("pickBestValidatorByYield candidate filtering", () => {
	it("selects only permitted validators with non-zero stake and ignores unpermitted higher-yield entries", async () => {
		const api = makeApi({
			hotkeys: ["hk0", "hk1", "hk2"],
			validator_permit: [true, false, true],
			alpha_stake: [10n, 1n, 0n],
			alpha_dividends_per_hotkey: [
				["hk0", 5n],
				["hk1", 100n],
				["hk2", 100n],
			],
			validators: [0, 1, 2],
		} as SelectiveMetagraph);

		const result = await pickBestValidatorByYield(api, 19);

		expect(result.hotkey).toBe("hk0");
		expect(result.candidate).toMatchObject({
			uid: 0,
			hotkey: "hk0",
			alphaStake: 10n,
			alphaDividends: 5n,
		});
	});

	it("fails when subnet metadata is missing", async () => {
		const api = makeApi(undefined);

		await expect(pickBestValidatorByYield(api, 45)).rejects.toThrow(
			"Subnet 45 not found",
		);
	});

	it("fails when no permitted validator has positive stake", async () => {
		const api = makeApi({
			hotkeys: ["hk0", "hk1"],
			validator_permit: [false, true],
			alpha_stake: [10n, 0n],
			alpha_dividends_per_hotkey: [
				["hk0", 3n],
				["hk1", 9n],
			],
			validators: [0, 1],
		} as SelectiveMetagraph);

		await expect(pickBestValidatorByYield(api, 7)).rejects.toThrow(
			"No permitted validator candidate with non-zero stake on SN7",
		);
	});
});

describe("pickBestValidatorByYield deterministic ranking", () => {
	it("prefers the highest yield-per-alpha candidate", async () => {
		const api = makeApi({
			hotkeys: ["hk0", "hk1"],
			validator_permit: [true, true],
			alpha_stake: [10n, 10n],
			alpha_dividends_per_hotkey: [
				["hk0", 5n],
				["hk1", 8n],
			],
			validators: [0, 1],
		} as SelectiveMetagraph);

		const result = await pickBestValidatorByYield(api, 11);

		expect(result.hotkey).toBe("hk1");
		expect(result.candidate.yieldPerAlpha).toBe(0.8);
	});

	it("breaks equal yield-per-alpha ties by higher alpha stake", async () => {
		const api = makeApi({
			hotkeys: ["hk0", "hk1"],
			validator_permit: [true, true],
			alpha_stake: [10n, 20n],
			alpha_dividends_per_hotkey: [
				["hk0", 1n],
				["hk1", 2n],
			],
			validators: [0, 1],
		} as SelectiveMetagraph);

		const result = await pickBestValidatorByYield(api, 12);

		expect(result.hotkey).toBe("hk1");
		expect(result.candidate.alphaStake).toBe(20n);
	});

	it("breaks equal yield and equal stake ties by lower UID", async () => {
		const api = makeApi({
			hotkeys: ["hk0", "hk1", "hk2"],
			validator_permit: [true, true, true],
			alpha_stake: [20n, 20n, 20n],
			alpha_dividends_per_hotkey: [
				["hk0", 2n],
				["hk1", 2n],
				["hk2", 2n],
			],
			validators: [2, 1, 0],
		} as SelectiveMetagraph);

		const result = await pickBestValidatorByYield(api, 13);

		expect(result.hotkey).toBe("hk0");
		expect(result.candidate.uid).toBe(0);
	});
});

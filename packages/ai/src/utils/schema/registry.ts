import type { DialectTransforms } from "./dialect";

export interface DialectSpec {
	id: string;
	supportedKeywords: ReadonlyArray<string>;
	supportedStringFormats: ReadonlyArray<string>;
	transforms: DialectTransforms;
}

const DEFAULT_TRANSFORMS: DialectTransforms = {
	flattenTopLevelCombiners: false,
	flattenAllCombiners: false,
	requirePropertiesOnObjects: false,
	pruneDanglingRequired: false,
	constAsEnum: false,
	oneOfAsAnyOf: false,
};

export const OPENAI: DialectSpec = {
	id: "openai",
	supportedKeywords: [
		"description",
		"default",
		"examples",
		"format",
		"anyOf",
		"oneOf",
		"allOf",
		"$defs",
		"definitions",
		"$ref",
		"$schema",
		"const",
		"additionalProperties",
		"patternProperties",
		"prefixItems",
		"minimum",
		"maximum",
		"exclusiveMinimum",
		"exclusiveMaximum",
		"multipleOf",
		"minLength",
		"maxLength",
		"pattern",
		"minItems",
		"maxItems",
		"nullable",
	],
	supportedStringFormats: ["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"],
	transforms: {
		...DEFAULT_TRANSFORMS,
		oneOfAsAnyOf: true,
	},
};

export const GEMINI: DialectSpec = {
	id: "gemini",
	supportedKeywords: [
		"description",
		"default",
		"format",
		"anyOf",
		"nullable",
		"minimum",
		"maximum",
		"minItems",
		"maxItems",
		"minLength",
		"maxLength",
		"pattern",
		"example",
	],
	supportedStringFormats: [],
	transforms: {
		...DEFAULT_TRANSFORMS,
		pruneDanglingRequired: true,
		constAsEnum: true,
		oneOfAsAnyOf: true,
	},
};

export const ANTHROPIC: DialectSpec = {
	id: "anthropic",
	supportedKeywords: [
		"description",
		"default",
		"examples",
		"format",
		"anyOf",
		"oneOf",
		"allOf",
		"not",
		"if",
		"then",
		"else",
		"$defs",
		"definitions",
		"$ref",
		"$schema",
		"$comment",
		"const",
		"additionalProperties",
		"patternProperties",
		"propertyNames",
		"prefixItems",
		"contains",
		"uniqueItems",
		"minimum",
		"maximum",
		"exclusiveMinimum",
		"exclusiveMaximum",
		"multipleOf",
		"minLength",
		"maxLength",
		"pattern",
		"minItems",
		"maxItems",
		"minProperties",
		"maxProperties",
		"dependentRequired",
		"dependentSchemas",
		"nullable",
	],
	supportedStringFormats: [],
	transforms: {
		...DEFAULT_TRANSFORMS,
		flattenTopLevelCombiners: true,
	},
};

export const OPENROUTER: DialectSpec = {
	id: "openrouter",
	supportedKeywords: OPENAI.supportedKeywords,
	supportedStringFormats: [],
	transforms: {
		...DEFAULT_TRANSFORMS,
		flattenTopLevelCombiners: true,
		requirePropertiesOnObjects: true,
	},
};

export const AERY_CLAUDE: DialectSpec = {
	id: "aery-claude",
	supportedKeywords: ANTHROPIC.supportedKeywords,
	supportedStringFormats: [],
	transforms: {
		...DEFAULT_TRANSFORMS,
		flattenAllCombiners: true,
	},
};

export const AERY_BRIDGE: DialectSpec = {
	id: "aery-bridge",
	supportedKeywords: [
		"description",
		"default",
		"examples",
		"format",
		"anyOf",
		"oneOf",
		"allOf",
		"$defs",
		"definitions",
		"$ref",
		"const",
		"additionalProperties",
		"patternProperties",
		"minimum",
		"maximum",
		"pattern",
		"nullable",
	],
	supportedStringFormats: [],
	transforms: {
		...DEFAULT_TRANSFORMS,
		flattenAllCombiners: true,
	},
};

export const ALL: ReadonlyArray<DialectSpec> = [OPENAI, GEMINI, ANTHROPIC, OPENROUTER, AERY_CLAUDE, AERY_BRIDGE];

export function byId(id: string): DialectSpec | undefined {
	return ALL.find(spec => spec.id === id);
}

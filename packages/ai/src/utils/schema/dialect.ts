import type { DialectSpec } from "./registry";
import { isJsonObject } from "./types";

export interface DialectTransforms {
	flattenTopLevelCombiners: boolean;
	flattenAllCombiners: boolean;
	requirePropertiesOnObjects: boolean;
	pruneDanglingRequired: boolean;
	constAsEnum: boolean;
	oneOfAsAnyOf: boolean;
}

export interface LearnedQuirks {
	rejectedKeywords: string[];
	rejectedFormats: string[];
}

const UNIVERSAL_KEYWORDS = ["type", "properties", "items", "required", "enum", "title"];
const LOAD_BEARING_KEYWORDS = ["type", "properties", "items", "required", "enum", "description"];

export enum KeywordRole {
	Subschema = 1,
	SubschemaMap = 2,
	SubschemaArray = 3,
	Data = 4,
}

const SUBSCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

const SUBSCHEMA_KEYWORDS = new Set([
	"items",
	"additionalItems",
	"additionalProperties",
	"contains",
	"propertyNames",
	"not",
	"if",
	"then",
	"else",
	"unevaluatedItems",
	"unevaluatedProperties",
	"contentSchema",
]);

const SUBSCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples", "required"]);

export function keywordRole(key: string): KeywordRole {
	if (SUBSCHEMA_MAP_KEYWORDS.has(key)) return KeywordRole.SubschemaMap;
	if (SUBSCHEMA_KEYWORDS.has(key)) return KeywordRole.Subschema;
	if (SUBSCHEMA_ARRAY_KEYWORDS.has(key)) return KeywordRole.SubschemaArray;
	if (DATA_KEYWORDS.has(key)) return KeywordRole.Data;
	return KeywordRole.Data;
}

export function isDroppable(key: string): boolean {
	return !LOAD_BEARING_KEYWORDS.includes(key);
}

function supports(spec: DialectSpec, key: string): boolean {
	return UNIVERSAL_KEYWORDS.includes(key) || spec.supportedKeywords.includes(key);
}

function supportsFormat(spec: DialectSpec, format: string): boolean {
	return spec.supportedStringFormats.length === 0 || spec.supportedStringFormats.includes(format);
}

export function applyDialect(schema: unknown, spec: DialectSpec, quirks?: LearnedQuirks): unknown {
	const q = quirks ?? { rejectedKeywords: [], rejectedFormats: [] };
	let out = walk(schema, spec, q);

	if (spec.transforms.flattenAllCombiners) {
		out = flattenAllCombiners(out);
	} else if (spec.transforms.flattenTopLevelCombiners) {
		out = flattenTopLevelCombiners(out);
	}

	if (spec.transforms.requirePropertiesOnObjects) {
		if (isJsonObject(out) && isObjectTyped(out)) {
			if (!Object.hasOwn(out, "properties")) {
				out.properties = {};
			}
		} else if (isJsonObject(out) && Object.keys(out).length === 0) {
			out.type = "object";
			out.properties = {};
		}
	}

	return out;
}

function isObjectTyped(map: Record<string, unknown>): boolean {
	const t = map.type;
	if (t === "object") return true;
	if (Array.isArray(t) && t.includes("object")) return true;
	return false;
}

function pruneDanglingRequired(out: Record<string, unknown>) {
	const properties = out.properties;
	if (!isJsonObject(properties)) return;
	const defined = new Set(Object.keys(properties));
	if (Array.isArray(out.required)) {
		const newRequired = out.required.filter(name => typeof name === "string" && defined.has(name));
		if (newRequired.length === 0) {
			delete out.required;
		} else {
			out.required = newRequired;
		}
	}
}

function walk(schema: unknown, spec: DialectSpec, quirks: LearnedQuirks): unknown {
	if (Array.isArray(schema)) {
		return schema.map(i => walk(i, spec, quirks));
	}
	if (!isJsonObject(schema)) {
		return schema;
	}

	const out: Record<string, unknown> = {};
	for (const key in schema) {
		if (!Object.hasOwn(schema, key)) continue;
		const value = schema[key];

		const outKey = key === "oneOf" && spec.transforms.oneOfAsAnyOf ? "anyOf" : key;
		const droppedByQuirk = quirks.rejectedKeywords.includes(key);

		if ((!supports(spec, outKey) || droppedByQuirk) && isDroppable(key)) {
			if (key === "const" && spec.transforms.constAsEnum) {
				out["enum"] = [value];
			}
			continue;
		}

		if (key === "format") {
			const formatStr = typeof value === "string" ? value : undefined;
			if (formatStr) {
				const ok = supportsFormat(spec, formatStr) && !quirks.rejectedFormats.includes(formatStr);
				if (ok) {
					out[key] = value;
				}
			} else {
				out[key] = value;
			}
			continue;
		}

		let normalized: unknown;
		switch (keywordRole(key)) {
			case KeywordRole.SubschemaMap:
				if (isJsonObject(value)) {
					const children: Record<string, unknown> = {};
					for (const childKey in value) {
						if (Object.hasOwn(value, childKey)) {
							children[childKey] = walk(value[childKey], spec, quirks);
						}
					}
					normalized = children;
				} else {
					normalized = value;
				}
				break;
			case KeywordRole.SubschemaArray:
				if (Array.isArray(value)) {
					normalized = value.map(i => walk(i, spec, quirks));
				} else {
					normalized = walk(value, spec, quirks);
				}
				break;
			case KeywordRole.Subschema:
				normalized = walk(value, spec, quirks);
				break;
			case KeywordRole.Data:
				normalized = value;
				break;
		}

		if (outKey === "anyOf" && Array.isArray(out.anyOf) && Array.isArray(normalized)) {
			out.anyOf = [...out.anyOf, ...normalized];
		} else {
			out[outKey] = normalized;
		}
	}

	if (spec.transforms.pruneDanglingRequired) {
		pruneDanglingRequired(out);
	}
	if (spec.transforms.requirePropertiesOnObjects && isObjectTyped(out)) {
		if (!Object.hasOwn(out, "properties")) {
			out.properties = {};
		}
	}

	return out;
}

function flattenTopLevelCombiners(schema: unknown): unknown {
	if (!isJsonObject(schema)) return schema;

	const mergedProperties = isJsonObject(schema.properties) ? { ...schema.properties } : {};
	const allOfRequired = new Set<string>();
	let sawCombiner = false;

	const out = { ...schema };

	for (const keyword of ["oneOf", "anyOf", "allOf"]) {
		const branches = out[keyword];
		if (!Array.isArray(branches)) continue;
		delete out[keyword];
		sawCombiner = true;

		for (const branch of branches) {
			if (!isJsonObject(branch)) continue;
			if (isJsonObject(branch.properties)) {
				for (const name in branch.properties) {
					if (!Object.hasOwn(branch.properties, name)) continue;
					if (!Object.hasOwn(mergedProperties, name)) {
						mergedProperties[name] = branch.properties[name];
					}
				}
			}
			if (keyword === "allOf" && Array.isArray(branch.required)) {
				for (const name of branch.required) {
					if (typeof name === "string") {
						allOfRequired.add(name);
					}
				}
			}
		}
	}

	if (!sawCombiner) return schema;

	out.type = "object";
	out.properties = mergedProperties;

	if (allOfRequired.size > 0) {
		const existingRequired = Array.isArray(out.required) ? out.required : [];
		const newRequired = new Set(existingRequired);
		for (const name of allOfRequired) {
			newRequired.add(name);
		}
		out.required = Array.from(newRequired);
	}

	pruneDanglingRequired(out);
	return out;
}

function mergeProperty(parent: unknown, branch: unknown): unknown {
	if (!isJsonObject(parent) || !isJsonObject(branch)) return parent;
	const merged = { ...branch };
	for (const key in parent) {
		if (Object.hasOwn(parent, key) && !Object.hasOwn(merged, key)) {
			merged[key] = parent[key];
		}
	}
	return merged;
}

function flattenAllCombiners(schema: unknown): unknown {
	if (Array.isArray(schema)) {
		return schema.map(flattenAllCombiners);
	}
	if (!isJsonObject(schema)) {
		return schema;
	}

	for (const combiner of ["anyOf", "oneOf", "allOf"]) {
		const branches = schema[combiner];
		if (Array.isArray(branches) && branches.length > 0) {
			const first = branches[0];
			let flattened = flattenAllCombiners(first);
			if (!isJsonObject(flattened)) return flattened;
			flattened = { ...flattened };

			for (const key in schema) {
				if (!Object.hasOwn(schema, key) || key === combiner) continue;
				const sibling = flattenAllCombiners(schema[key]);

				if (key === "properties" && isJsonObject(flattened.properties) && isJsonObject(sibling)) {
					const existing = flattened.properties;
					const incoming = sibling;
					for (const name in incoming) {
						if (!Object.hasOwn(incoming, name)) continue;
						const property = incoming[name];
						if (Object.hasOwn(existing, name)) {
							existing[name] = mergeProperty(existing[name], property);
						} else {
							existing[name] = property;
						}
					}
				} else if (!Object.hasOwn(flattened, key)) {
					flattened[key] = sibling;
				}
			}
			pruneDanglingRequired(flattened);
			return flattened;
		}
	}

	const out: Record<string, unknown> = {};
	for (const key in schema) {
		if (Object.hasOwn(schema, key)) {
			out[key] = flattenAllCombiners(schema[key]);
		}
	}
	return out;
}

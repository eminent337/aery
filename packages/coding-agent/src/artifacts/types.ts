/**
 * Types for Aery Interactive Artifacts.
 *
 * Modeled after agy's persistent structured artifacts system.
 */

export interface ArtifactMetadata {
	summary: string;
	userFacing?: boolean;
	requestFeedback?: boolean;
	createdAt?: number;
	updatedAt?: number;
}

export interface StoredArtifact {
	id: string;
	filename: string;
	path: string;
	metadata: ArtifactMetadata;
	content: string;
}

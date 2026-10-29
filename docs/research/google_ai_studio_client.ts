/** Auto-generated TypeScript definitions for Web Client & Services by leanai */

export type DiscoveredModel = "gemini-1.5-flash" | "gemini-2.0-flash" | "gemini-2.5-flash" | "gemini-2.5-flash-image" | "gemini-2.5-pro" | "gemini-3" | "gemini-3-flash-preview" | "gemini-3-pro-image" | "gemini-3.0-flash" | "gemini-3.0-pro" | "gemini-3.1-flash-image-preview" | "gemini-3.1-pro-preview" | "models/gemini-2-5-flash-image" | "models/gemini-2.0" | "models/gemini-2.0-flash" | "models/gemini-2.5-flash" | "models/gemini-2.5-pro" | "models/gemini-3" | "models/gemini-3-1-flash-image" | "models/gemini-3-1-flash-image-preview" | "models/gemini-3-pro-image" | "models/gemini-3.8-flash" | "models/lyria" | "models/veo" | "models/veo-3" | "models/veo-3.0-fast-generate-001" | "models/veo-3.1-generate-preview";

export type DiscoveredRoute =
  | "/**"
  | "/upload/drive/v3/files"
  | "/403"
  | "/404"
  | "/500"
  | "/520"
  | "/:agentId"
  | "/:agentId/:tab"
  | "/:triggerId"
  | "/:triggerId/edit"
  | "/agent-dashboard"
  | "/agents"
  | "/api-keys"
  | "/apikey"
  | "/app"
  | "/apps"
  | "/apps/:id"
  | "/apps/:source/:id"
  | "/apps/bundled/veo_cameos"
  | "/apps/bundled/video-toys"
  | "/apps/created-by-you"
  | "/apps/gist/:id/:subid"
  | "/apps/github"
  | "/apps/googlesource"
  | "/apps/zip"
  | "/auth/figma/uiredirect"
  | "/auth/github/uiredirect"
  | "/bidi"
  | "/billing"
  | "/build"
  | "/build-an-app"
  | "/canvas"
  | "/case-studies"
  | "/case-studies/:id"
  | "/config";

export interface AppletImportService {
  importApplet(params: Record<string, unknown>): Promise<unknown>;
}

export interface CloudSqlService {
  checkFeatureEligibility(params: Record<string, unknown>): Promise<unknown>;
  getCurrentCloudSqlRegion(params: Record<string, unknown>): Promise<unknown>;
  getDefaultCloudSqlRegion(params: Record<string, unknown>): Promise<unknown>;
  listSupportedRegions(params: Record<string, unknown>): Promise<unknown>;
  updateSchema(params: Record<string, unknown>): Promise<unknown>;
}

export interface MakersuiteAppletControlService {
  applyFileSystemOperation(params: Record<string, unknown>): Promise<unknown>;
  buildApplet(params: Record<string, unknown>): Promise<unknown>;
  clearAppletDependencies(params: Record<string, unknown>): Promise<unknown>;
  createApplet(params: Record<string, unknown>): Promise<unknown>;
  createUserSnapshot(params: Record<string, unknown>): Promise<unknown>;
  execCommand(params: Record<string, unknown>): Promise<unknown>;
  forgetOrchestratorMemory(params: Record<string, unknown>): Promise<unknown>;
  forkApplet(params: Record<string, unknown>): Promise<unknown>;
  getBufferedLogs(params: Record<string, unknown>): Promise<unknown>;
  installAppletDependencies(params: Record<string, unknown>): Promise<unknown>;
  installPackage(params: Record<string, unknown>): Promise<unknown>;
  loadSnapshotIntoContainer(params: Record<string, unknown>): Promise<unknown>;
  restartAppletDevServer(params: Record<string, unknown>): Promise<unknown>;
  restoreAppletToSnapshot(params: Record<string, unknown>): Promise<unknown>;
  saveOrchestratorMemory(params: Record<string, unknown>): Promise<unknown>;
  streamAppletBlobs(params: Record<string, unknown>): Promise<unknown>;
  streamLogs(params: Record<string, unknown>): Promise<unknown>;
}

export interface OAuthService {
  addBrandScopes(params: Record<string, unknown>): Promise<unknown>;
  addBrandTestUser(params: Record<string, unknown>): Promise<unknown>;
  generateBrandLogo(params: Record<string, unknown>): Promise<unknown>;
  getOAuthBrand(params: Record<string, unknown>): Promise<unknown>;
  listBrandTestUsers(params: Record<string, unknown>): Promise<unknown>;
  listOAuthClients(params: Record<string, unknown>): Promise<unknown>;
  updateBrandDetails(params: Record<string, unknown>): Promise<unknown>;
}

export interface MakerSuiteService {
  acceptCloudSqlTos(params: Record<string, unknown>): Promise<unknown>;
  acceptTerms(params: Record<string, unknown>): Promise<unknown>;
  acceptTermsOfService(params: Record<string, unknown>): Promise<unknown>;
  addEvalSubmission(params: Record<string, unknown>): Promise<unknown>;
  attachCustomDomain(params: Record<string, unknown>): Promise<unknown>;
  autocompleteAppletPrompt(params: Record<string, unknown>): Promise<unknown>;
  autocompletePrompt(params: Record<string, unknown>): Promise<unknown>;
  batchCheckCloudRunServices(params: Record<string, unknown>): Promise<unknown>;
  batchGetCredits(params: Record<string, unknown>): Promise<unknown>;
  batchGetProjectUsageLimits(params: Record<string, unknown>): Promise<unknown>;
  bulkDeleteSessionTurns(params: Record<string, unknown>): Promise<unknown>;
  cancelCodeAssistantOfflineGeneration(params: Record<string, unknown>): Promise<unknown>;
  cancelInteraction(params: Record<string, unknown>): Promise<unknown>;
  checkCloudRunService(params: Record<string, unknown>): Promise<unknown>;
  checkGitHubSyncStatus(params: Record<string, unknown>): Promise<unknown>;
  checkImage(params: Record<string, unknown>): Promise<unknown>;
  checkSharedAppletDeployment(params: Record<string, unknown>): Promise<unknown>;
  checkUserStatus(params: Record<string, unknown>): Promise<unknown>;
  claimGdpCredits(params: Record<string, unknown>): Promise<unknown>;
  claimNextEvalTask(params: Record<string, unknown>): Promise<unknown>;
  clearEvalActiveAttempt(params: Record<string, unknown>): Promise<unknown>;
  codeAssistantOffline(params: Record<string, unknown>): Promise<unknown>;
  computeStagedGitHubDiff(params: Record<string, unknown>): Promise<unknown>;
  contributeSessionTurn(params: Record<string, unknown>): Promise<unknown>;
  countSessionTurns(params: Record<string, unknown>): Promise<unknown>;
  // ... and 247 more methods
}

export interface AndroidEmulatorService {
  getLogcat(params: Record<string, unknown>): Promise<unknown>;
  getScreenshot(params: Record<string, unknown>): Promise<unknown>;
}

export interface AndroidPublishingService {
  listDevelopers(params: Record<string, unknown>): Promise<unknown>;
  updateTesters(params: Record<string, unknown>): Promise<unknown>;
  uploadApp(params: Record<string, unknown>): Promise<unknown>;
}

export interface AppletAuthService {
  mintAppletAuthToken(params: Record<string, unknown>): Promise<unknown>;
}

export interface AppletExportService {
  exportApplet(params: Record<string, unknown>): Promise<unknown>;
}

export interface AppletGenerationService {
  cancelAgentFollowUpMessage(params: Record<string, unknown>): Promise<unknown>;
  cancelAgentTask(params: Record<string, unknown>): Promise<unknown>;
  editAgentFollowUpMessage(params: Record<string, unknown>): Promise<unknown>;
  sendAgentFollowUpMessage(params: Record<string, unknown>): Promise<unknown>;
  streamRunAgentTask(params: Record<string, unknown>): Promise<unknown>;
}

export interface AppletService {
  deleteApplet(params: Record<string, unknown>): Promise<unknown>;
  deleteAppletSecret(params: Record<string, unknown>): Promise<unknown>;
  listAppletSecrets(params: Record<string, unknown>): Promise<unknown>;
  listAppletsByGroup(params: Record<string, unknown>): Promise<unknown>;
  listUnsetAppletSecrets(params: Record<string, unknown>): Promise<unknown>;
  reconcileDevEnvironment(params: Record<string, unknown>): Promise<unknown>;
  remixApplet(params: Record<string, unknown>): Promise<unknown>;
  streamAppletDebugInfo(params: Record<string, unknown>): Promise<unknown>;
  updateApplet(params: Record<string, unknown>): Promise<unknown>;
  uploadAppletIcon(params: Record<string, unknown>): Promise<unknown>;
  upsertAppletSecret(params: Record<string, unknown>): Promise<unknown>;
}

export interface DocumentationService {
  getResource(params: Record<string, unknown>): Promise<unknown>;
}

export interface HarmSetting {
  category: number;
  threshold: number;
}

export interface GenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  thinkingBudget?: number;
  thinkingLevel?: string;
  responseMimeType?: string;
  responseModalities?: string[];
  speechConfig?: Record<string, unknown>;
  aspectRatio?: string;
  outputResolution?: string;
  durationSeconds?: number;
  safetySettings?: HarmSetting[];
  enableSearchAsATool?: boolean;
  enableImageSearch?: boolean;
  enableGoogleMaps?: boolean;
  enableCodeExecution?: boolean;
  functionDeclarations?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

export interface BoqProxyCallRequest {
  method: string;
  request: string;
  httpMethod: "GET" | "POST" | "DELETE" | "PUT";
  project?: string;
  headers?: Record<string, string>;
  fileContent?: Uint8Array;
}


import "dotenv/config";

export const config = {
  port: Number(process.env.PORT || 8787),
  backendOrigin: process.env.BACKEND_ORIGIN || "http://localhost:8787",
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
  groqApiKey: process.env.GROQ_API_KEY || "",
  // gpt-oss-120b is Groq's current recommended tool-use model (as of the
  // June 2026 deprecation of llama-3.3-70b-versatile etc.) — overridable
  // since Groq's supported-model list shifts.
  groqModel: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  // Separate vision-capable model for the "import from a screenshot" feature —
  // gpt-oss-120b has no image input. llama-4-scout is Groq's multimodal model
  // (confirmed in both the vision docs and the live models table). Overridable
  // since Groq's model list shifts and this one is a preview model.
  groqVisionModel: process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct",
  swiggy: {
    authIssuer: "https://mcp.swiggy.com/auth",
    metadataUrl: "https://mcp.swiggy.com/.well-known/oauth-authorization-server",
    foodServerUrl: "https://mcp.swiggy.com/food",
    instamartServerUrl: "https://mcp.swiggy.com/im",
    scope: "mcp:tools mcp:resources mcp:prompts",
  },
};

export const REDIRECT_PATH = "/auth/callback";
export const redirectUri = () => `${config.backendOrigin}${REDIRECT_PATH}`;

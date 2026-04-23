import { complete, getModel } from "@eminent337/aery-ai";

const model = getModel("google", "gemini-2.5-flash");
console.log(model.id, typeof complete);

import Groq from "groq-sdk"
import { z } from "zod"
import { extractText, getDocumentProxy } from "unpdf"
import mammoth from "mammoth"

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const PDF_MIME = "application/pdf"
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

const analysisSchema = z.object({
  matchScore: z
    .number()
    .min(0)
    .max(100)
    .describe("Overall match percentage between resume and job description"),
  matchedKeywords: z
    .array(z.string())
    .describe("Keywords from the job description that appear in the resume"),
  missingKeywords: z
    .array(z.string())
    .describe(
      "Important keywords from the job description that are missing from the resume"
    ),
  suggestions: z
    .array(z.string())
    .describe(
      "Specific, actionable suggestions for improving the resume to better match the job"
    ),
  coverLetter: z
    .string()
    .describe(
      "A professional cover letter tailored to the job description, highlighting relevant experience from the resume"
    ),
})

async function extractResumeText(file) {
  const fileType = file.type || ""

  if (fileType === PDF_MIME) {
    const arrayBuffer = await file.arrayBuffer()
    const buffer = new Uint8Array(arrayBuffer)
    const pdf = await getDocumentProxy(buffer)
    const { text } = await extractText(pdf, { mergePages: true })
    return text
  }

  if (fileType === DOCX_MIME) {
    const arrayBuffer = await file.arrayBuffer()
    const nodeBuffer = Buffer.from(arrayBuffer)
    const result = await mammoth.extractRawText({ buffer: nodeBuffer })
    return result.value
  }

  if (fileType === "text/plain") {
    return await file.text()
  }

  throw new Error(
    "Unsupported file type. Please upload a PDF, DOCX, or plain text file."
  )
}

export async function POST(req) {
  try {
    const formData = await req.formData()
    const resumeFile = formData.get("resume")
    const jobDescription = formData.get("jobDescription")

    if (!resumeFile || typeof resumeFile === "string") {
      return Response.json(
        { error: "Resume file is required (PDF, DOCX, or plain text)." },
        { status: 400 }
      )
    }

    if (!jobDescription || typeof jobDescription !== "string") {
      return Response.json(
        { error: "Job description is required." },
        { status: 400 }
      )
    }

    const resumeText = await extractResumeText(resumeFile)

    if (!resumeText?.trim()) {
      return Response.json(
        { error: "Could not extract text from the resume file." },
        { status: 400 }
      )
    }

    const prompt = `You are an expert ATS resume analyst. Analyze this resume against the job description.

Resume: ${resumeText}
Job Description: ${jobDescription}

Return ONLY a JSON object. Rules for suggestions:
- Never suggest removing experience that is directly relevant to the job posting
- Focus suggestions on adding missing keywords naturally into existing bullet points
- Cover letter must reference the specific company name and role from the job description
- Match score should reflect keyword overlap AND transferable skills, not just exact matches

JSON must have exactly these keys: matchScore (number), matchedKeywords (array of strings), missingKeywords (array of strings), suggestions (array of strings), coverLetter (string).`

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 4000,
    })

    const rawContent = completion.choices[0].message.content
    const parsed = JSON.parse(rawContent)
    const result = analysisSchema.parse(parsed)

    return Response.json(result)

  } catch (error) {
    console.error("Analysis error:", error.message)
    return Response.json(
      {
        error:
          error.message?.startsWith("Unsupported file type") ||
          error.message?.startsWith("Could not extract")
            ? error.message
            : "Failed to analyze application. Please try again.",
      },
      { status: error.message?.startsWith("Unsupported") ? 400 : 500 }
    )
  }
}

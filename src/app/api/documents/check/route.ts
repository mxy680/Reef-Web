import { NextRequest, NextResponse } from "next/server"
import { createClient, createServiceClient } from "../../../../lib/supabase/server"

const REEF_SERVER_URL =
  process.env.REEF_SERVER_URL ||
  process.env.NEXT_PUBLIC_REEF_API_URL ||
  "http://localhost:8000"

export async function POST(request: NextRequest) {
  try {
    const { documentId } = await request.json()
    if (!documentId) {
      return NextResponse.json({ error: "documentId required" }, { status: 400 })
    }

    // Validate user session
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Check job status on Reef-Server
    const statusRes = await fetch(
      `${REEF_SERVER_URL}/ai/reconstruct/jobs/${encodeURIComponent(documentId)}`,
      { signal: AbortSignal.timeout(10_000) },
    )

    if (statusRes.status === 404) {
      return NextResponse.json({ status: "not_found" })
    }

    if (!statusRes.ok) {
      return NextResponse.json({ status: "error" }, { status: 502 })
    }

    const job = await statusRes.json()
    const serviceClient = createServiceClient()

    if (job.status === "processing") {
      return NextResponse.json({ status: "processing" })
    }

    if (job.status === "failed") {
      await serviceClient
        .from("documents")
        .update({ status: "failed", error_message: (job.error || "Unknown error").slice(0, 500) })
        .eq("id", documentId)
        .eq("user_id", user.id)
      return NextResponse.json({ status: "failed" })
    }

    // Job completed — download the result PDF and upload to Supabase Storage
    const resultRes = await fetch(
      `${REEF_SERVER_URL}/ai/reconstruct/jobs/${encodeURIComponent(documentId)}/result`,
      { signal: AbortSignal.timeout(60_000) },
    )

    if (!resultRes.ok) {
      await serviceClient
        .from("documents")
        .update({ status: "failed", error_message: "Failed to download result from server" })
        .eq("id", documentId)
        .eq("user_id", user.id)
      return NextResponse.json({ status: "failed" })
    }

    const outputBlob = await resultRes.blob()
    const outputPath = `${user.id}/${documentId}/output.pdf`
    const { error: uploadError } = await serviceClient.storage
      .from("documents")
      .upload(outputPath, outputBlob, {
        contentType: "application/pdf",
        upsert: true,
      })

    if (uploadError) {
      await serviceClient
        .from("documents")
        .update({ status: "failed", error_message: "Failed to save reconstructed PDF" })
        .eq("id", documentId)
        .eq("user_id", user.id)
      return NextResponse.json({ status: "failed" })
    }

    // Update document status to completed
    await serviceClient
      .from("documents")
      .update({
        status: "completed",
        page_count: job.page_count ?? null,
        problem_count: job.problem_count ?? null,
      })
      .eq("id", documentId)
      .eq("user_id", user.id)

    return NextResponse.json({ status: "completed" })
  } catch (e) {
    console.error("[documents/check]", e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Internal error" },
      { status: 500 },
    )
  }
}

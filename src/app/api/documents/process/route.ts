import { NextRequest, NextResponse } from "next/server"
import { createClient, createServiceClient } from "../../../../lib/supabase/server"
import { getUserTier, getLimits } from "../../../../lib/limits"

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

    // Enforce document count limit
    const tier = await getUserTier()
    const limits = getLimits(tier)
    const { count, error: countError } = await supabase
      .from("documents")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)

    if (countError) {
      return NextResponse.json({ error: "Failed to check document count" }, { status: 500 })
    }
    if ((count ?? 0) > limits.maxDocuments) {
      return NextResponse.json({ error: "Document limit reached" }, { status: 403 })
    }

    // Service role client for updates (bypasses RLS)
    const serviceClient = createServiceClient()

    // Fetch document row and verify ownership
    const { data: doc, error: fetchError } = await serviceClient
      .from("documents")
      .select("*")
      .eq("id", documentId)
      .eq("user_id", user.id)
      .single()

    if (fetchError || !doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 })
    }

    // Download original PDF from Supabase Storage
    const storagePath = `${user.id}/${documentId}/original.pdf`
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(storagePath)

    if (downloadError || !fileData) {
      await serviceClient
        .from("documents")
        .update({ status: "failed", error_message: "Failed to download original PDF" })
        .eq("id", documentId)
      return NextResponse.json({ error: "Failed to download PDF" }, { status: 500 })
    }

    // Submit to Reef-Server for async processing
    const formData = new FormData()
    formData.append("pdf", fileData, doc.filename)

    let response: Response
    try {
      response = await fetch(
        `${REEF_SERVER_URL}/ai/reconstruct/submit?document_id=${encodeURIComponent(documentId)}`,
        {
          method: "POST",
          body: formData,
          signal: AbortSignal.timeout(30_000), // 30s — just for the submit handshake
        },
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : "Reef Server unreachable"
      await serviceClient
        .from("documents")
        .update({ status: "failed", error_message: message })
        .eq("id", documentId)
      return NextResponse.json({ error: message }, { status: 502 })
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error")
      await serviceClient
        .from("documents")
        .update({ status: "failed", error_message: errorText.slice(0, 500) })
        .eq("id", documentId)
      return NextResponse.json({ error: "Submit failed" }, { status: 502 })
    }

    return NextResponse.json({ status: "processing" })
  } catch (e) {
    console.error("[documents/process]", e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Internal error" },
      { status: 500 }
    )
  }
}

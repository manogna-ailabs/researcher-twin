import { NextRequest, NextResponse } from 'next/server'
import { ensureDataDirs } from '@/lib/server/fsStore'
import { enforceApiSecurity } from '@/lib/server/security'
import { saveUploadedFiles } from '@/lib/server/assetStore'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const securityError = enforceApiSecurity(request, {
    routeId: 'upload',
    maxRequests: Number.parseInt(process.env.RATE_LIMIT_UPLOAD_MAX || '60', 10),
  })
  if (securityError) return securityError

  try {
    await ensureDataDirs()

    const formData = await request.formData()
    const rawFiles = formData.getAll('files')
    const files = rawFiles.filter((file): file is File => file instanceof File)

    if (files.length === 0) {
      return NextResponse.json(
        {
          success: false,
          asset_ids: [],
          files: [],
          total_files: 0,
          successful_uploads: 0,
          failed_uploads: 0,
          message: 'No files provided',
          timestamp: new Date().toISOString(),
          error: 'No files provided',
        },
        { status: 400 }
      )
    }

    const { uploaded, failed } = await saveUploadedFiles(files)

    return NextResponse.json({
      success: failed.length === 0,
      asset_ids: uploaded.map(asset => asset.asset_id),
      files: [
        ...uploaded.map(asset => ({
          asset_id: asset.asset_id,
          file_name: asset.file_name,
          success: true,
        })),
        ...failed.map(item => ({
          asset_id: '',
          file_name: item.file_name,
          success: false,
          error: item.error,
        })),
      ],
      total_files: files.length,
      successful_uploads: uploaded.length,
      failed_uploads: failed.length,
      message: `Uploaded ${uploaded.length}/${files.length} file(s)`,
      timestamp: new Date().toISOString(),
      ...(failed.length > 0 ? { error: 'Some files could not be fully processed for text extraction' } : {}),
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        asset_ids: [],
        files: [],
        total_files: 0,
        successful_uploads: 0,
        failed_uploads: 0,
        message: 'Server error during upload',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}

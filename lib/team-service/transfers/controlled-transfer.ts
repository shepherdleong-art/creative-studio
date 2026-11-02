export function controlledUploadRequired(): Response {
  return Response.json({
    error: 'controlled_upload_required',
    message: '服务器模式请使用分片上传，不再接收整批 multipart 或服务器路径。',
    uploadEndpoint: '/api/team/uploads',
  }, { status: 409, headers: { 'Cache-Control': 'private, no-store' } });
}

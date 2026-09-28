Deno.serve((_req) => {
  return Response.json({
    service: 'penzfa-core',
    status: 'ok',
  })
})

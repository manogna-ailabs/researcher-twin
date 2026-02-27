const PUBLIC_API_TOKEN = process.env.NEXT_PUBLIC_API_AUTH_TOKEN

function withAuthHeader(input: RequestInfo | URL, init?: RequestInit): [RequestInfo | URL, RequestInit] {
  if (!PUBLIC_API_TOKEN) {
    return [input, init || {}]
  }

  const headers = new Headers(init?.headers || {})
  if (!headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${PUBLIC_API_TOKEN}`)
  }

  return [input, {
    ...(init || {}),
    headers,
  }]
}

const fetchWrapper = async (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    const [finalInput, finalInit] = withAuthHeader(input, init)
    const response = await fetch(finalInput, finalInit)

    if (response.redirected) {
      window.location.href = response.url
      return
    }

    if (response.status === 404) {
      const contentType = response.headers.get('content-type') || ''

      if (contentType.includes('text/html')) {
        const html = await response.text()
        document.open()
        document.write(html)
        document.close()
        return
      }
    }

    return response
  } catch (error) {
    throw error
  }
}

export default fetchWrapper

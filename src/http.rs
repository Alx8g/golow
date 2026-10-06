//! HTTPS through Windows' own stack (WinHTTP), so proxies and certificates work as they do in
//! Windows. Used for Last.fm, lyrics and update checks; SoundCloud itself stays in WebView2.
use url::Url;
use windows::{
    core::{HSTRING, PCWSTR},
    Win32::Networking::WinHttp::*,
};

pub const USER_AGENT: &str =
    concat!("GoLow/", env!("CARGO_PKG_VERSION"), " (+https://github.com/Alx8g/golow)");

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

/// One request. `headers` are CRLF-separated lines; at most `limit` bytes are read.
pub fn request(
    method: &str,
    url: &Url,
    headers: &str,
    body: &[u8],
    limit: usize,
) -> Option<Response> {
    if url.scheme() != "https" {
        return None;
    }
    let host = HSTRING::from(url.host_str()?);
    let path = HSTRING::from(&url[url::Position::BeforePath..url::Position::AfterQuery]);
    let port = url.port().unwrap_or(443);
    unsafe {
        let session = WinHttpOpen(
            &HSTRING::from(USER_AGENT),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        );
        if session.is_null() {
            return None;
        }
        let _ = WinHttpSetTimeouts(session, 10_000, 10_000, 15_000, 30_000);
        let connection = WinHttpConnect(session, &host, port, 0);
        let request = WinHttpOpenRequest(
            connection,
            &HSTRING::from(method),
            &path,
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        );
        let header_text: Vec<u16> = headers.encode_utf16().collect();
        let sent = !request.is_null()
            && WinHttpSendRequest(
                request,
                (!header_text.is_empty()).then_some(header_text.as_slice()),
                (!body.is_empty()).then_some(body.as_ptr().cast()),
                body.len() as u32,
                body.len() as u32,
                0,
            )
            .is_ok()
            && WinHttpReceiveResponse(request, std::ptr::null_mut()).is_ok();
        let mut status = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let known = sent
            && WinHttpQueryHeaders(
                request,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                PCWSTR::null(),
                Some((&mut status as *mut u32).cast()),
                &mut size,
                std::ptr::null_mut(),
            )
            .is_ok();
        let mut response = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        let mut read = 0;
        while known
            && response.len() < limit
            && WinHttpReadData(request, chunk.as_mut_ptr().cast(), chunk.len() as u32, &mut read)
                .is_ok()
            && read > 0
        {
            response.extend_from_slice(&chunk[..read as usize]);
        }
        for handle in [request, connection, session] {
            if !handle.is_null() {
                let _ = WinHttpCloseHandle(handle);
            }
        }
        (known && response.len() <= limit)
            .then_some(Response { status: status as u16, body: response })
    }
}

pub fn get_json(url: &Url) -> Option<serde_json::Value> {
    let response = request("GET", url, "Accept: application/json", &[], 4 * 1024 * 1024)?;
    (response.status == 200).then(|| serde_json::from_slice(&response.body).ok()).flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_plain_http() {
        assert!(request("GET", &Url::parse("http://example.com/").unwrap(), "", &[], 10).is_none());
    }
}

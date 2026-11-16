//! Helpers shared by the unit tests.
use std::{
    sync::mpsc::{self, RecvTimeoutError},
    time::Duration,
};

/// Runs a test body that starts processes on a thread of its own, and fails
/// the test when the body outlives `limit`: the harness has no per-test
/// timeout, so a child that never exits would otherwise hold the whole run
/// (and the CI job) until it is killed from outside.
pub(crate) fn within<T: Send + 'static>(limit: Duration, body: impl FnOnce() -> T + Send + 'static) -> T {
    let (sender, receiver) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let _ = sender.send(body());
    });
    match receiver.recv_timeout(limit) {
        Ok(value) => {
            let _ = worker.join();
            value
        }
        // the body panicked: report its own failure, not a timeout
        Err(RecvTimeoutError::Disconnected) => match worker.join() {
            Err(panic) => std::panic::resume_unwind(panic),
            Ok(()) => unreachable!("the body returned without sending its value"),
        },
        Err(RecvTimeoutError::Timeout) => panic!("the test was still running after {limit:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_what_the_body_returns() {
        assert_eq!(within(Duration::from_secs(5), || 42), 42);
    }

    #[test]
    #[should_panic(expected = "still running")]
    fn fails_a_body_that_overruns() {
        within(Duration::from_millis(50), || std::thread::sleep(Duration::from_secs(5)));
    }

    #[test]
    #[should_panic(expected = "its own failure")]
    fn passes_the_bodys_panic_through() {
        within(Duration::from_secs(5), || panic!("its own failure"));
    }
}

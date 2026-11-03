//! Where paired-token records persist: one OS keychain item per app instance,
//! under the human key's service, so debug and release builds never share.
use zeroize::Zeroizing;

pub(crate) trait Keychain: Send + Sync {
    /// The saved records, or `None` when none are saved.
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String>;
    /// Replaces the saved records; `None` deletes them.
    fn write(&self, value: Option<&[u8]>) -> Result<(), String>;
}

#[cfg_attr(test, allow(dead_code))]
pub(crate) fn account(instance: &str) -> String {
    format!("credential-pairings.v1.{instance}")
}

#[cfg(not(test))]
pub(crate) struct Os(pub(crate) String);

#[cfg(all(
    not(test),
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
impl Keychain for Os {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        use buzz_credential_store as store;
        match store::read(store::HUMAN_SERVICE, &self.0) {
            Ok(value) => Ok(Some(value)),
            Err(store::Error::Absent) => Ok(None),
            Err(_) => Err("Paired tools could not be read from secure storage".into()),
        }
    }
    fn write(&self, value: Option<&[u8]>) -> Result<(), String> {
        use buzz_credential_store as store;
        let failed = |_| "Paired tools could not be saved to secure storage".to_string();
        match store::delete(store::HUMAN_SERVICE, &self.0) {
            Ok(()) | Err(store::Error::Absent) => {}
            Err(error) => return Err(failed(error)),
        }
        match value {
            Some(value) => store::add(store::HUMAN_SERVICE, &self.0, value).map_err(failed),
            None => Ok(()),
        }
    }
}

#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
impl Keychain for Os {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        Err("Secure storage is not available on this platform".into())
    }
    fn write(&self, _: Option<&[u8]>) -> Result<(), String> {
        Err("Secure storage is not available on this platform".into())
    }
}

/// An in-memory keychain whose reads and writes can be made to fail.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Memory {
    pub(crate) value: std::sync::Mutex<Option<Vec<u8>>>,
    pub(crate) fail_read: std::sync::atomic::AtomicBool,
    pub(crate) fail_write: std::sync::atomic::AtomicBool,
}
#[cfg(test)]
impl Keychain for std::sync::Arc<Memory> {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        if self.fail_read.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("read failed".into());
        }
        Ok(self.value.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn write(&self, value: Option<&[u8]>) -> Result<(), String> {
        if self.fail_write.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("write failed".into());
        }
        *self.value.lock().unwrap() = value.map(<[u8]>::to_vec);
        Ok(())
    }
}

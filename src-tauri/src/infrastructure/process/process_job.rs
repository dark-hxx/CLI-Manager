#[cfg(target_os = "windows")]
pub(crate) struct ChildJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
unsafe impl Send for ChildJob {}

#[cfg(target_os = "windows")]
impl ChildJob {
    pub(crate) fn assign(child: &std::process::Child, label: &str) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(format!(
                    "create {label} job object failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                let err = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(format!("configure {label} job object failed: {err}"));
            }
            if AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
                let err = std::io::Error::last_os_error();
                CloseHandle(job);
                return Err(format!("assign {label} process to job failed: {err}"));
            }
            Ok(Self(job))
        }
    }

    pub(crate) fn terminate(&self) {
        unsafe {
            let _ = windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for ChildJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

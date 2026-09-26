use crate::error::AppError;

pub fn parse_profile_id(profile_id: &str) -> Result<i64, AppError> {
    let trimmed = profile_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("profile id cannot be empty".to_owned()));
    }
    trimmed
        .parse::<i64>()
        .map_err(|_| AppError::Validation(format!("invalid profile id: {profile_id}")))
}

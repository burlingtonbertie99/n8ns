curl --request POST   --url "https://api.hubapi.com/crm/v3/objects/companies/search"   --header "Authorization: Bearer YOUR_ACCESS_TOKEN"  --header "Content-Type: application/json"   --data '{
    "filterGroups": [{
      "filters": [{
        "propertyName": "name",
        "operator": "EQ",
        "value": $1
      }]
    }],
    "properties": ["name"]
  }'


{"total":1,"results":[{"id":"3839964661","properties":{"createdate":"2020-05-06T07:51:18.046Z","hs_lastmodifieddate":"2025-10-20T14:18:19.828Z","hs_object_id":"3839964661","
name":"Permanent TSB"},"createdAt":"2020-05-06T07:51:18.046Z","updatedAt":"2025-10-20T14:18:19.828Z","archived":false}]}

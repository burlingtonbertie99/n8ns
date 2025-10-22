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
